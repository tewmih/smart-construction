"""Aggregates project data into a ReportData payload for both preview JSON and PDF rendering."""
import calendar
import logging
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.commons import TaskStatus
from app.models.log import DailyLog, Equipment, EquipmentIdle, Manpower, Material
from app.models.project import Project, ProjectProgressSnapshot
from app.models.system import AuditLog, BudgetItem, BudgetPayment
from app.models.task import Task
from app.models.user import User
from app.schemas.report import (
    ApprovalInfo,
    BudgetSnapshot,
    DailyLogsSummary,
    EarnedValueMetrics,
    EquipmentSection,
    EquipmentUsage,
    ExecutiveSummary,
    FinancialSection,
    LookAheadSection,
    ManpowerSection,
    LookAheadTask,
    ManpowerEntry,
    MaterialsSection,
    PeriodCumulative,
    ProgressSection,
    ProjectHeader,
    ReportData,
    ReportPeriod,
    ReportPeriodInfo,
    ReportSection,
    SCurvePoint,
    TaskBrief,
    TasksReport,
    WeatherSection,
)
from app.services import risk as risk_service

logger = logging.getLogger(__name__)

WEATHER_DISRUPTION_KEYWORDS = ("rain", "storm", "snow", "flood", "wind", "heat")


def _project_tz(project: Project) -> ZoneInfo:
    try:
        return ZoneInfo(project.timezone or "UTC")
    except ZoneInfoNotFoundError:
        logger.warning("report_data: unknown timezone %r, falling back to UTC", project.timezone)
        return ZoneInfo("UTC")


def _start_of_day(d: date, tz: ZoneInfo) -> datetime:
    return datetime.combine(d, time.min, tzinfo=tz)


def _end_of_day(d: date, tz: ZoneInfo) -> datetime:
    return datetime.combine(d, time.max, tzinfo=tz)


def _to_utc(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc)


def _ensure_aware(dt: Optional[datetime], tz: ZoneInfo = timezone.utc) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=tz)
    return dt


def resolve_period(
    period: ReportPeriod,
    start: Optional[date],
    end: Optional[date],
    project: Project,
) -> ReportPeriodInfo:
    """
    Defaults (no start given) point to the LAST COMPLETED period in the project's tz.
    When `start` is provided for a non-custom period, snap to the period containing it.
    """
    tz = _project_tz(project)
    week_start_dow = int(project.week_starts_on or 0)        # 0=Mon, 6=Sun
    fy_start_month = int(project.fiscal_year_start_month or 1)
    today_local = datetime.now(tz).date()

    if period == ReportPeriod.CUSTOM:
        if not start or not end:
            raise ValueError("CUSTOM period requires both start and end")
        s_date, e_date = start, end
        label = f"{s_date.isoformat()} – {e_date.isoformat()}"

    elif period == ReportPeriod.DAILY:
        s_date = start or (today_local - timedelta(days=1))
        e_date = s_date
        label = s_date.strftime("%A, %d %b %Y")

    elif period == ReportPeriod.WEEKLY:
        anchor = start or (today_local - timedelta(days=7))
        offset = (anchor.weekday() - week_start_dow) % 7
        s_date = anchor - timedelta(days=offset)
        e_date = s_date + timedelta(days=6)
        label = f"Week of {s_date.strftime('%d %b')} – {e_date.strftime('%d %b %Y')}"

    elif period == ReportPeriod.MONTHLY:
        if start:
            s_date = date(start.year, start.month, 1)
        else:
            first_of_this = date(today_local.year, today_local.month, 1)
            last_of_prev = first_of_this - timedelta(days=1)
            s_date = date(last_of_prev.year, last_of_prev.month, 1)
        last_day = calendar.monthrange(s_date.year, s_date.month)[1]
        e_date = date(s_date.year, s_date.month, last_day)
        label = s_date.strftime("%B %Y")

    elif period == ReportPeriod.ANNUAL:
        if start:
            anchor_year = start.year if start.month >= fy_start_month else start.year - 1
        else:
            if today_local.month >= fy_start_month:
                anchor_year = today_local.year - 1
            else:
                anchor_year = today_local.year - 2
        s_date = date(anchor_year, fy_start_month, 1)
        end_year = anchor_year + 1 if fy_start_month > 1 else anchor_year
        end_month = fy_start_month - 1 if fy_start_month > 1 else 12
        if fy_start_month == 1:
            end_year = anchor_year
        last_day = calendar.monthrange(end_year, end_month)[1]
        e_date = date(end_year, end_month, last_day)
        label = (
            f"FY {s_date.year}/{str(e_date.year)[-2:]}" if fy_start_month != 1 else f"FY {s_date.year}"
        )

    else:
        raise ValueError(f"Unsupported period: {period}")

    start_dt = _start_of_day(s_date, tz)
    end_dt = _end_of_day(e_date, tz)
    return ReportPeriodInfo(
        period=period,
        start=start_dt,
        end=end_dt,
        label=label,
        cut_off=end_dt,
        project_timezone=str(tz),
    )


# ───────────────────── Section builders ─────────────────────

async def _executive_summary(
    db: AsyncSession, project: Project, period_info: ReportPeriodInfo, m: dict,
    risk_level: Optional[str], risk_confidence: Optional[float],
) -> ExecutiveSummary:
    budget = await _budget_snapshot(db, project)
    days_elapsed = risk_service.days_between(project.planned_start_date, datetime.now(timezone.utc))
    days_total = m["planned_total_days"]
    days_remaining = max(0, days_total - days_elapsed)

    planned_progress = None
    if days_total > 0 and project.planned_start_date:
        elapsed_to_cut = risk_service.days_between(project.planned_start_date, _to_utc(period_info.cut_off))
        planned_progress = round(min(100.0, (elapsed_to_cut / days_total) * 100.0), 2)

    schedule_variance_days = -m["delay_estimate_days"]

    pv = (project.total_budget or 0.0) * ((planned_progress or 0.0) / 100.0)
    ev = (project.total_budget or 0.0) * (m["progress"])
    ac = float(project.budget_spent or 0.0)
    spi = (ev / pv) if pv > 0 else 1.0
    cpi = (ev / ac) if ac > 0 else 1.0

    progress_period = await _progress_in_period(db, project, period_info)
    weather_section = await _weather_section(db, project.id, period_info)

    tasks = list((await db.execute(select(Task).where(Task.project_id == project.id))).scalars().all())
    overdue = sum(
        1 for t in tasks
        if t.status != TaskStatus.COMPLETED.value
        and t.end_date and _ensure_aware(t.end_date) < _to_utc(period_info.cut_off)
    )

    return ExecutiveSummary(
        progress=PeriodCumulative(
            period=progress_period,
            cumulative=round(m["progress"] * 100.0, 2),
        ),
        planned_progress=planned_progress,
        days_elapsed=days_elapsed,
        days_remaining=days_remaining,
        schedule_variance_days=schedule_variance_days,
        spi=round(spi, 3),
        cpi=round(cpi, 3),
        budget=budget,
        task_counts={
            "total": m["total_tasks"],
            "completed": m["completed_tasks"],
            "in_progress": m["in_progress_tasks"],
            "overdue": overdue,
        },
        risk_level=risk_level,
        risk_confidence=risk_confidence,
        weather_days_lost=weather_section.weather_days_lost,
    )


async def _budget_snapshot(db: AsyncSession, project: Project) -> BudgetSnapshot:
    received = (await db.execute(
        select(func.coalesce(func.sum(BudgetPayment.payment_amount), 0.0)).where(BudgetPayment.project_id == project.id)
    )).scalar() or 0.0
    total = float(project.total_budget or 0.0)
    spent = float(project.budget_spent or 0.0)
    return BudgetSnapshot(
        total_budget=total,
        budget_spent=spent,
        total_received=float(received),
        remaining=total - spent,
    )


async def _progress_in_period(db: AsyncSession, project: Project, period_info: ReportPeriodInfo) -> float:
    """Approximate progress made *within* the period from snapshot deltas."""
    snaps = list((await db.execute(
        select(ProjectProgressSnapshot)
        .where(ProjectProgressSnapshot.project_id == project.id)
        .order_by(ProjectProgressSnapshot.snapshot_date)
    )).scalars().all())
    if not snaps:
        return round(float(project.progress_percentage or 0.0), 2)
    start_utc = _to_utc(period_info.start)
    end_utc = _to_utc(period_info.end)
    before = [s for s in snaps if _ensure_aware(s.snapshot_date) < start_utc]
    in_or_before_end = [s for s in snaps if _ensure_aware(s.snapshot_date) <= end_utc]
    start_progress = before[-1].progress_percentage if before else 0.0
    end_progress = in_or_before_end[-1].progress_percentage if in_or_before_end else start_progress
    return round(max(0.0, end_progress - start_progress), 2)


async def _progress_section(db: AsyncSession, project: Project, period_info: ReportPeriodInfo, m: dict) -> ProgressSection:
    snaps = list((await db.execute(
        select(ProjectProgressSnapshot)
        .where(ProjectProgressSnapshot.project_id == project.id)
        .where(ProjectProgressSnapshot.snapshot_date <= _to_utc(period_info.cut_off))
        .order_by(ProjectProgressSnapshot.snapshot_date)
    )).scalars().all())
    s_curve = [
        SCurvePoint(
            date=_ensure_aware(s.snapshot_date).date(),
            planned_progress=s.planned_progress,
            actual_progress=s.progress_percentage,
            cumulative_cost=s.budget_spent,
        )
        for s in snaps
    ]
    days_elapsed = risk_service.days_between(project.planned_start_date, datetime.now(timezone.utc))
    days_remaining = max(0, m["planned_total_days"] - days_elapsed)
    return ProgressSection(
        s_curve=s_curve,
        progress_this_period=PeriodCumulative(
            period=await _progress_in_period(db, project, period_info),
            cumulative=round(float(project.progress_percentage or 0.0), 2),
        ),
        days_elapsed=days_elapsed,
        days_remaining=days_remaining,
        schedule_variance_days=-m["delay_estimate_days"],
    )


def _evm(project: Project, planned_progress: float, actual_progress: float) -> EarnedValueMetrics:
    total = float(project.total_budget or 0.0)
    pv = total * (planned_progress / 100.0)
    ev = total * (actual_progress / 100.0)
    ac = float(project.budget_spent or 0.0)
    spi = (ev / pv) if pv > 0 else 1.0
    cpi = (ev / ac) if ac > 0 else 1.0

    def _status(idx: float) -> str:
        if idx > 1.05:
            return "ahead" if idx == spi else "under"
        if idx < 0.95:
            return "behind" if idx == spi else "over"
        return "on_track"

    return EarnedValueMetrics(
        spi=round(spi, 3),
        cpi=round(cpi, 3),
        spi_status="ahead" if spi > 1.05 else ("behind" if spi < 0.95 else "on_track"),
        cpi_status="under" if cpi > 1.05 else ("over" if cpi < 0.95 else "on_track"),
        planned_value=round(pv, 2),
        earned_value=round(ev, 2),
        actual_cost=round(ac, 2),
    )


async def _logs_in_window(
    db: AsyncSession, project_id: UUID, start_utc: datetime, end_utc: datetime
) -> list[DailyLog]:
    """Only PM-approved logs are eligible for reporting.
    Submitted / consultant-approved / draft / rejected entries are excluded so reports
    reflect ratified data only."""
    res = await db.execute(
        select(DailyLog)
        .where(DailyLog.project_id == project_id)
        .where(DailyLog.status == "pm_approved")
        .where(DailyLog.date >= start_utc)
        .where(DailyLog.date <= end_utc)
    )
    return list(res.scalars().all())


async def _all_logs(db: AsyncSession, project_id: UUID) -> list[DailyLog]:
    """Only PM-approved logs are eligible for reporting."""
    res = await db.execute(
        select(DailyLog)
        .where(DailyLog.project_id == project_id)
        .where(DailyLog.status == "pm_approved")
    )
    return list(res.scalars().all())


async def _manpower_section(db: AsyncSession, project_id: UUID, period_info: ReportPeriodInfo) -> ManpowerSection:
    start_utc, end_utc = _to_utc(period_info.start), _to_utc(period_info.end)
    period_logs = await _logs_in_window(db, project_id, start_utc, end_utc)
    all_logs = await _all_logs(db, project_id)

    period_log_ids = [l.id for l in period_logs]
    cum_log_ids = [l.id for l in all_logs]

    period_manpower = await _fetch_manpower(db, period_log_ids)
    cum_manpower = await _fetch_manpower(db, cum_log_ids)

    histogram_map: dict[date, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    log_id_to_date = {l.id: _ensure_aware(l.date).date() for l in period_logs}
    for mp in period_manpower:
        d = log_id_to_date.get(mp.log_id)
        if d:
            histogram_map[d][mp.worker_type or "unspecified"] += float(mp.hours_worked or 0.0)

    histogram = [
        ManpowerEntry(date=d, by_trade=dict(trades), total=sum(trades.values()))
        for d, trades in sorted(histogram_map.items())
    ]

    by_trade: dict[str, PeriodCumulative] = {}
    period_by_trade: dict[str, float] = defaultdict(float)
    cum_by_trade: dict[str, float] = defaultdict(float)
    for mp in period_manpower:
        period_by_trade[mp.worker_type or "unspecified"] += float(mp.hours_worked or 0.0)
    for mp in cum_manpower:
        cum_by_trade[mp.worker_type or "unspecified"] += float(mp.hours_worked or 0.0)
    for trade in set(period_by_trade) | set(cum_by_trade):
        by_trade[trade] = PeriodCumulative(
            period=round(period_by_trade.get(trade, 0.0), 2),
            cumulative=round(cum_by_trade.get(trade, 0.0), 2),
        )

    return ManpowerSection(
        histogram=histogram,
        total_hours=PeriodCumulative(
            period=round(sum(float(l.hours_worked or 0.0) for l in period_manpower), 2),
            cumulative=round(sum(float(l.hours_worked or 0.0) for l in cum_manpower), 2),
        ),
        total_cost=PeriodCumulative(
            period=round(sum(float(l.cost or 0.0) for l in period_manpower), 2),
            cumulative=round(sum(float(l.cost or 0.0) for l in cum_manpower), 2),
        ),
        by_trade=by_trade,
    )


async def _fetch_manpower(db: AsyncSession, log_ids: list[UUID]) -> list[Manpower]:
    if not log_ids:
        return []
    res = await db.execute(select(Manpower).where(Manpower.log_id.in_(log_ids)))
    return list(res.scalars().all())


async def _fetch_materials(db: AsyncSession, log_ids: list[UUID]) -> list[Material]:
    if not log_ids:
        return []
    res = await db.execute(select(Material).where(Material.log_id.in_(log_ids)))
    return list(res.scalars().all())


async def _fetch_equipment(db: AsyncSession, log_ids: list[UUID]) -> list[Equipment]:
    if not log_ids:
        return []
    res = await db.execute(select(Equipment).where(Equipment.log_id.in_(log_ids)))
    return list(res.scalars().all())


async def _fetch_idle(db: AsyncSession, equip_ids: list[UUID]) -> list[EquipmentIdle]:
    if not equip_ids:
        return []
    res = await db.execute(select(EquipmentIdle).where(EquipmentIdle.equipment_id.in_(equip_ids)))
    return list(res.scalars().all())


async def _equipment_section(db: AsyncSession, project_id: UUID, period_info: ReportPeriodInfo) -> EquipmentSection:
    start_utc, end_utc = _to_utc(period_info.start), _to_utc(period_info.end)
    period_logs = await _logs_in_window(db, project_id, start_utc, end_utc)
    all_logs = await _all_logs(db, project_id)

    period_equip = await _fetch_equipment(db, [l.id for l in period_logs])
    cum_equip = await _fetch_equipment(db, [l.id for l in all_logs])
    period_idle = await _fetch_idle(db, [e.id for e in period_equip])
    cum_idle = await _fetch_idle(db, [e.id for e in cum_equip])

    # Idle hours can live in two places: directly on the Equipment row (set at
    # log-creation time via the daily-log form) OR as separate EquipmentIdle
    # rows added through /equipment/{id}/idle. Both must contribute to totals.
    by_name: dict[str, dict] = defaultdict(lambda: {"used": 0.0, "idle": 0.0, "reasons": defaultdict(float)})
    idle_by_equip: dict[UUID, list[EquipmentIdle]] = defaultdict(list)
    for i in period_idle:
        idle_by_equip[i.equipment_id].append(i)

    for e in period_equip:
        name = e.name or "Unnamed"
        by_name[name]["used"] += float(e.hours_used or 0.0)
        # 1) Idle hours recorded inline on the Equipment row.
        inline_idle = float(e.idle_hours or 0.0)
        if inline_idle > 0:
            by_name[name]["idle"] += inline_idle
            inline_reason = (e.idle_reason or "unspecified").strip() or "unspecified"
            by_name[name]["reasons"][inline_reason] += inline_idle
        # 2) Idle hours from the child EquipmentIdle table.
        for i in idle_by_equip.get(e.id, []):
            by_name[name]["idle"] += float(i.hours_idle or 0.0)
            by_name[name]["reasons"][i.reason or "unspecified"] += float(i.hours_idle or 0.0)

    by_equipment: list[EquipmentUsage] = []
    for name, data in by_name.items():
        total = data["used"] + data["idle"]
        util_pct = (data["used"] / total * 100.0) if total > 0 else 0.0
        top_reasons = sorted(
            [{"reason": r, "hours": round(h, 2)} for r, h in data["reasons"].items()],
            key=lambda x: x["hours"], reverse=True,
        )[:5]
        by_equipment.append(EquipmentUsage(
            name=name,
            hours_used=round(data["used"], 2),
            hours_idle=round(data["idle"], 2),
            utilization_pct=round(util_pct, 2),
            top_idle_reasons=top_reasons,
        ))

    period_used = sum(float(e.hours_used or 0.0) for e in period_equip)
    cum_used = sum(float(e.hours_used or 0.0) for e in cum_equip)
    # Include both inline idle_hours and EquipmentIdle rows in the section totals.
    period_idle_h = (
        sum(float(e.idle_hours or 0.0) for e in period_equip)
        + sum(float(i.hours_idle or 0.0) for i in period_idle)
    )
    cum_idle_h = (
        sum(float(e.idle_hours or 0.0) for e in cum_equip)
        + sum(float(i.hours_idle or 0.0) for i in cum_idle)
    )
    overall_total = period_used + period_idle_h
    overall_util = (period_used / overall_total * 100.0) if overall_total > 0 else 0.0

    return EquipmentSection(
        by_equipment=sorted(by_equipment, key=lambda x: x.hours_used, reverse=True),
        total_hours_used=PeriodCumulative(period=round(period_used, 2), cumulative=round(cum_used, 2)),
        total_hours_idle=PeriodCumulative(period=round(period_idle_h, 2), cumulative=round(cum_idle_h, 2)),
        total_cost=PeriodCumulative(
            period=round(sum(float(e.cost or 0.0) for e in period_equip), 2),
            cumulative=round(sum(float(e.cost or 0.0) for e in cum_equip), 2),
        ),
        overall_utilization_pct=round(overall_util, 2),
    )


async def _materials_section(db: AsyncSession, project_id: UUID, period_info: ReportPeriodInfo) -> MaterialsSection:
    start_utc, end_utc = _to_utc(period_info.start), _to_utc(period_info.end)
    period_logs = await _logs_in_window(db, project_id, start_utc, end_utc)
    all_logs = await _all_logs(db, project_id)

    period_mats = await _fetch_materials(db, [l.id for l in period_logs])
    cum_mats = await _fetch_materials(db, [l.id for l in all_logs])

    agg: dict[str, dict] = defaultdict(lambda: {"qty": 0.0, "cost": 0.0, "unit": ""})
    for m in period_mats:
        key = m.name or "unspecified"
        agg[key]["qty"] += float(m.quantity or 0.0)
        agg[key]["cost"] += float(m.cost or 0.0)
        agg[key]["unit"] = m.unit or agg[key]["unit"]

    items = [
        {"name": k, "quantity": round(v["qty"], 2), "cost": round(v["cost"], 2), "unit": v["unit"]}
        for k, v in agg.items()
    ]
    top_by_cost = sorted(items, key=lambda x: x["cost"], reverse=True)[:10]
    top_by_qty = sorted(items, key=lambda x: x["quantity"], reverse=True)[:10]

    return MaterialsSection(
        top_by_cost=top_by_cost,
        top_by_quantity=top_by_qty,
        total_cost=PeriodCumulative(
            period=round(sum(float(m.cost or 0.0) for m in period_mats), 2),
            cumulative=round(sum(float(m.cost or 0.0) for m in cum_mats), 2),
        ),
    )


async def _weather_section(db: AsyncSession, project_id: UUID, period_info: ReportPeriodInfo) -> WeatherSection:
    start_utc, end_utc = _to_utc(period_info.start), _to_utc(period_info.end)
    logs = await _logs_in_window(db, project_id, start_utc, end_utc)
    breakdown: dict[str, int] = defaultdict(int)
    days_lost = 0
    for l in logs:
        w = (l.weather or "").lower().strip()
        if not w:
            continue
        if any(k in w for k in WEATHER_DISRUPTION_KEYWORDS):
            days_lost += 1
            for k in WEATHER_DISRUPTION_KEYWORDS:
                if k in w:
                    breakdown[k] += 1
                    break
    days_in_period = (period_info.end.date() - period_info.start.date()).days + 1
    return WeatherSection(
        weather_days_lost=days_lost,
        weather_breakdown=dict(breakdown),
        days_in_period=days_in_period,
    )


async def _financial_section(db: AsyncSession, project: Project, period_info: ReportPeriodInfo) -> FinancialSection:
    start_utc, end_utc = _to_utc(period_info.start), _to_utc(period_info.end)
    period_logs = await _logs_in_window(db, project.id, start_utc, end_utc)
    all_logs = await _all_logs(db, project.id)

    period_manpower = await _fetch_manpower(db, [l.id for l in period_logs])
    cum_manpower = await _fetch_manpower(db, [l.id for l in all_logs])
    period_mats = await _fetch_materials(db, [l.id for l in period_logs])
    cum_mats = await _fetch_materials(db, [l.id for l in all_logs])
    period_equip = await _fetch_equipment(db, [l.id for l in period_logs])
    cum_equip = await _fetch_equipment(db, [l.id for l in all_logs])

    period_incoming = (await db.execute(
        select(func.coalesce(func.sum(BudgetPayment.payment_amount), 0.0))
        .where(BudgetPayment.project_id == project.id)
        .where(BudgetPayment.created_at >= start_utc)
        .where(BudgetPayment.created_at <= end_utc)
    )).scalar() or 0.0
    cum_incoming = (await db.execute(
        select(func.coalesce(func.sum(BudgetPayment.payment_amount), 0.0))
        .where(BudgetPayment.project_id == project.id)
    )).scalar() or 0.0

    days = max(1, (period_info.end.date() - period_info.start.date()).days + 1)
    period_total_cost = (
        sum(float(l.cost or 0.0) for l in period_manpower)
        + sum(float(m.cost or 0.0) for m in period_mats)
        + sum(float(e.cost or 0.0) for e in period_equip)
    )

    return FinancialSection(
        budget=await _budget_snapshot(db, project),
        manpower_cost=PeriodCumulative(
            period=round(sum(float(l.cost or 0.0) for l in period_manpower), 2),
            cumulative=round(sum(float(l.cost or 0.0) for l in cum_manpower), 2),
        ),
        material_cost=PeriodCumulative(
            period=round(sum(float(m.cost or 0.0) for m in period_mats), 2),
            cumulative=round(sum(float(m.cost or 0.0) for m in cum_mats), 2),
        ),
        equipment_cost=PeriodCumulative(
            period=round(sum(float(e.cost or 0.0) for e in period_equip), 2),
            cumulative=round(sum(float(e.cost or 0.0) for e in cum_equip), 2),
        ),
        incoming_budget=PeriodCumulative(
            period=round(float(period_incoming), 2),
            cumulative=round(float(cum_incoming), 2),
        ),
        burn_rate_per_day=round(period_total_cost / days, 2),
    )


async def _tasks_section(db: AsyncSession, project_id: UUID, period_info: ReportPeriodInfo) -> TasksReport:
    start_utc, end_utc = _to_utc(period_info.start), _to_utc(period_info.end)
    res = await db.execute(select(Task).where(Task.project_id == project_id))
    tasks = list(res.scalars().all())

    completed = [
        t for t in tasks
        if t.status == TaskStatus.COMPLETED.value
        and t.end_date and start_utc <= _ensure_aware(t.end_date) <= end_utc
    ]
    started = [
        t for t in tasks
        if t.start_date and start_utc <= _ensure_aware(t.start_date) <= end_utc
    ]
    overdue = [
        t for t in tasks
        if t.status != TaskStatus.COMPLETED.value
        and t.end_date and _ensure_aware(t.end_date) < end_utc
    ]
    return TasksReport(
        completed_in_period=[TaskBrief.model_validate(t) for t in completed],
        started_in_period=[TaskBrief.model_validate(t) for t in started],
        overdue=[TaskBrief.model_validate(t) for t in overdue],
    )


async def _look_ahead_section(
    db: AsyncSession, project_id: UUID, period: ReportPeriod, cut_off_utc: datetime,
) -> LookAheadSection:
    horizon = 14 if period in (ReportPeriod.DAILY, ReportPeriod.WEEKLY) else 28
    horizon_end = cut_off_utc + timedelta(days=horizon)
    res = await db.execute(
        select(Task)
        .where(Task.project_id == project_id)
        .where(Task.start_date >= cut_off_utc)
        .where(Task.start_date <= horizon_end)
        .order_by(Task.start_date)
    )
    upcoming = list(res.scalars().all())
    return LookAheadSection(
        horizon_days=horizon,
        upcoming_tasks=[LookAheadTask.model_validate(t) for t in upcoming],
    )


async def _daily_logs_summary(db: AsyncSession, project_id: UUID, period_info: ReportPeriodInfo) -> DailyLogsSummary:
    logs = await _logs_in_window(db, project_id, _to_utc(period_info.start), _to_utc(period_info.end))
    by_status: dict[str, int] = defaultdict(int)
    for l in logs:
        by_status[l.status or "unknown"] += 1

    log_ids = [l.id for l in logs]
    manpower = await _fetch_manpower(db, log_ids)
    equip = await _fetch_equipment(db, log_ids)
    idle = await _fetch_idle(db, [e.id for e in equip])

    total_idle = (
        sum(float(e.idle_hours or 0.0) for e in equip)
        + sum(float(i.hours_idle or 0.0) for i in idle)
    )

    return DailyLogsSummary(
        log_count=len(logs),
        by_status=dict(by_status),
        total_manpower_hours=round(sum(float(l.hours_worked or 0.0) for l in manpower), 2),
        total_equipment_hours=round(sum(float(e.hours_used or 0.0) for e in equip), 2),
        equipment_idle_hours=round(total_idle, 2),
    )


async def _approval_info(project: Project) -> ApprovalInfo:
    return ApprovalInfo(
        status="draft",
        pm_name=project.owner.full_name if project.owner else None,
    )


async def _project_header(project: Project) -> ProjectHeader:
    return ProjectHeader(
        name=project.name,
        client_name=project.clients[0].name if project.clients else None,
        location=project.location,
        owner_name=project.owner.full_name if project.owner else None,
        status=project.status,
        planned_start=project.planned_start_date,
        planned_end=project.planned_end_date,
        contract_value=float(project.total_budget or 0.0),
    )


# ───────────────────── Snapshot helper ─────────────────────

async def maybe_capture_snapshot(db: AsyncSession, project: Project, cut_off_utc: datetime) -> None:
    """Insert a ProjectProgressSnapshot for the cut-off date if one doesn't already exist that day."""
    cut_off_day_start = cut_off_utc.replace(hour=0, minute=0, second=0, microsecond=0)
    cut_off_day_end = cut_off_day_start + timedelta(days=1)
    existing = (await db.execute(
        select(ProjectProgressSnapshot)
        .where(ProjectProgressSnapshot.project_id == project.id)
        .where(ProjectProgressSnapshot.snapshot_date >= cut_off_day_start)
        .where(ProjectProgressSnapshot.snapshot_date < cut_off_day_end)
    )).scalars().first()
    if existing:
        return
    snap = ProjectProgressSnapshot(
        project_id=project.id,
        snapshot_date=cut_off_utc,
        progress_percentage=float(project.progress_percentage or 0.0),
        budget_spent=float(project.budget_spent or 0.0),
        total_budget=float(project.total_budget or 0.0),
        captured_by="report_run",
    )
    db.add(snap)
    await db.commit()


# ───────────────────── Top-level orchestrator ─────────────────────

async def build_report_data(
    db: AsyncSession,
    project: Project,
    period: ReportPeriod,
    start: Optional[date],
    end: Optional[date],
    sections: set[ReportSection],
    generated_by: User,
) -> ReportData:
    period_info = resolve_period(period, start, end, project)
    m = await risk_service.compute_metrics(db, project)
    risk_level, confidence, source, ml_result, features = await risk_service.resolve_risk(db, project, m)

    summary = await _executive_summary(db, project, period_info, m, risk_level, confidence)

    progress_section = await _progress_section(db, project, period_info, m) if ReportSection.PROGRESS in sections else None
    performance = (
        _evm(project, summary.planned_progress or 0.0, summary.progress.cumulative)
        if ReportSection.PERFORMANCE in sections else None
    )
    financial = await _financial_section(db, project, period_info) if ReportSection.BUDGET in sections else None
    tasks = await _tasks_section(db, project.id, period_info) if ReportSection.TASKS in sections else None
    look_ahead = (
        await _look_ahead_section(db, project.id, period_info.period, _to_utc(period_info.cut_off))
        if ReportSection.LOOK_AHEAD in sections else None
    )
    manpower = await _manpower_section(db, project.id, period_info) if ReportSection.MANPOWER in sections else None
    equipment = await _equipment_section(db, project.id, period_info) if ReportSection.EQUIPMENT in sections else None
    materials = await _materials_section(db, project.id, period_info) if ReportSection.MATERIALS in sections else None
    weather = await _weather_section(db, project.id, period_info) if ReportSection.WEATHER in sections else None
    daily_logs = await _daily_logs_summary(db, project.id, period_info) if ReportSection.DAILY_LOGS in sections else None
    risk = (
        risk_service.build_factors(project, m, ml_result, features) | {"level": risk_level, "source": source}
        if ReportSection.RISK in sections else None
    )

    return ReportData(
        period=period_info,
        project=await _project_header(project),
        summary=summary,
        progress=progress_section,
        performance=performance,
        financial=financial,
        tasks=tasks,
        look_ahead=look_ahead,
        manpower=manpower,
        equipment=equipment,
        materials=materials,
        weather=weather,
        daily_logs=daily_logs,
        risk=risk,
        approval=await _approval_info(project),
        generated_at=datetime.now(timezone.utc),
        generated_by=generated_by.full_name,
    )
