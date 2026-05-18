import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from app.api.dependencies import DbSession, get_current_active_user
from app.models.commons import TaskStatus
from app.models.task import Task
from app.models.user import User
from app.models.log import DailyLog
from app.repositories.project import ProjectRepository
from app.services import ml_predictor
from app.services.feature_extractor import build_features
from app.services import analytics

logger = logging.getLogger(__name__)
router = APIRouter()
project_repo = ProjectRepository()


class RiskPredictionResponse(BaseModel):
    project_id: UUID
    risk_level: str                   # "low" | "medium" | "high" | "critical"
    delay_estimate_days: int
    budget_overrun_estimate: float
    confidence_score: float           # 0.0 – 1.0
    source: str                       # "ml" | "rule-based"
    reason: str                       # Human-readable insight
    recommendation: str               # Actionable recommendation
    factors: dict


def _days_between(d1: datetime, d2: datetime) -> int:
    if not d1 or not d2:
        return 0
    if d1.tzinfo is None:
        d1 = d1.replace(tzinfo=timezone.utc)
    if d2.tzinfo is None:
        d2 = d2.replace(tzinfo=timezone.utc)
    return max(0, (d2 - d1).days)


async def _compute_metrics(db, project) -> dict:
    """Pull schedule/budget/task numbers used for both numeric outputs and the rule fallback."""
    tasks = list((await db.execute(select(Task).where(Task.project_id == project.id))).scalars().all())
    total_tasks = len(tasks)
    completed = sum(1 for t in tasks if t.status == TaskStatus.COMPLETED.value)
    in_progress = sum(1 for t in tasks if t.status == TaskStatus.IN_PROGRESS.value)
    task_completion_rate = (completed / total_tasks) if total_tasks > 0 else 0.0

    progress = (project.progress_percentage or 0.0) / 100.0
    budget_ratio = (project.budget_spent / project.total_budget) if project.total_budget else 0.0
    budget_efficiency = budget_ratio / progress if progress > 0 else budget_ratio

    planned_total_days = _days_between(project.planned_start_date, project.planned_end_date)
    remaining_days = _days_between(datetime.now(timezone.utc), project.planned_end_date) if project.planned_end_date else 0
    schedule_deviation = 0.0
    
    if planned_total_days > 0 and project.planned_start_date:
        elapsed = _days_between(project.planned_start_date, datetime.now(timezone.utc))
        expected = min(elapsed / planned_total_days, 1.0)
        schedule_deviation = expected - progress

    delay_estimate_days = (
        int(schedule_deviation * planned_total_days)
        if planned_total_days > 0 and schedule_deviation > 0 else 0
    )

    budget_overrun_estimate = 0.0
    if budget_efficiency > 1.0 and progress > 0:
        projected = project.budget_spent / progress
        budget_overrun_estimate = max(0.0, projected - project.total_budget)

    return {
        "total_tasks": total_tasks,
        "completed_tasks": completed,
        "in_progress_tasks": in_progress,
        "task_completion_rate": task_completion_rate,
        "progress": progress,
        "budget_ratio": budget_ratio,
        "budget_efficiency": budget_efficiency,
        "schedule_deviation": schedule_deviation,
        "planned_total_days": planned_total_days,
        "remaining_days": remaining_days,
        "delay_estimate_days": delay_estimate_days,
        "budget_overrun_estimate": budget_overrun_estimate,
    }


def _rule_based_risk(budget_efficiency: float, schedule_deviation: float,
                     task_completion_rate: float, remaining_days: int, progress: float) -> tuple[str, float]:
    """Fallback used when the ML model is unavailable or no approved logs. Returns (risk_level, confidence)."""
    score = 0.0
    
    # Budget efficiency factor (40%)
    score += min(max(budget_efficiency - 1.0, 0.0), 1.0) * 0.4
    
    # Schedule deviation factor (30%)
    score += max(schedule_deviation, 0.0) * 0.3
    
    # Task completion factor (20%)
    score += (1.0 - task_completion_rate) * 0.2
    
    # Remaining time vs progress factor (10%)
    # If we have little time left but low progress, increase risk significantly
    if remaining_days > 0:
        if remaining_days < 30 and progress < 0.7:
            score += 0.15  # Critical: less than 30 days and below 70% progress
        elif remaining_days < 60 and progress < 0.5:
            score += 0.10  # High risk: less than 60 days and below 50% progress
        elif remaining_days < 90 and progress < 0.3:
            score += 0.05  # Medium risk: less than 90 days and below 30% progress
    
    score = max(0.0, min(score, 1.0))
    
    if score >= 0.6:
        level = "high"
    elif score >= 0.3:
        level = "medium"
    else:
        level = "low"
    
    # Rule-based confidence is intentionally lower than ML's max-prob.
    return level, 0.6


async def _resolve_risk(db, project, m: dict) -> tuple[str, float, str, dict | None, dict]:
    """
    Returns (risk_level, confidence, source, ml_result, features).
    
    Applies context-aware post-processing to ML predictions for early-stage projects.
    """
    
    # Count approved logs to determine if project has operational data
    approved_logs_res = await db.execute(
        select(DailyLog).where(
            DailyLog.project_id == project.id,
            DailyLog.status == "pm_approved"
        )
    )
    approved_logs_count = len(list(approved_logs_res.scalars().all()))
    
    # Always try ML model first
    if ml_predictor.is_loaded():
        logger.info("prediction: ML model is loaded, building features and calling predictor")
        features = await build_features(db, project)
        ml_result = ml_predictor.predict(features)
        
        if ml_result:
            raw_risk_level = ml_result["risk_level"]
            raw_confidence = ml_result["confidence"]
            
            logger.info(
                "prediction: ML raw output — risk_level=%s confidence=%.3f class_index=%d",
                raw_risk_level, raw_confidence, ml_result["class_index"],
            )
            
            # Post-processing: Adjust for early-stage projects
            # If project has no operational data (0 approved logs) and financial metrics are healthy,
            # override ML prediction to LOW risk
            if approved_logs_count == 0:
                logger.info("prediction: Planning phase detected (0 approved logs)")
                
                # Check if financial metrics are healthy
                is_on_budget = m["budget_efficiency"] <= 1.15  # Within 15% of budget
                is_on_schedule = m["schedule_deviation"] <= 0.10  # Within 10% of schedule
                
                if is_on_budget and is_on_schedule:
                    logger.info(
                        "prediction: Financial metrics healthy (budget_eff=%.2f, schedule_dev=%.2f) - overriding to LOW risk",
                        m["budget_efficiency"], m["schedule_deviation"]
                    )
                    
                    # Override to LOW risk with high confidence
                    adjusted_result = ml_result.copy()
                    adjusted_result["risk_level"] = "low"
                    adjusted_result["confidence"] = 0.80
                    adjusted_result["class_index"] = 0
                    # Adjust probabilities to reflect LOW risk
                    adjusted_result["probabilities"] = {
                        "low": 0.80,
                        "medium": 0.15,
                        "high": 0.04,
                        "critical": 0.01
                    }
                    
                    return "low", 0.80, "ml-adjusted", adjusted_result, features
                else:
                    logger.info(
                        "prediction: Financial metrics show issues - keeping ML prediction"
                    )
            
            elif approved_logs_count < 5:
                logger.info("prediction: Early mobilization phase (%d approved logs)", approved_logs_count)
                
                # For mobilization, if ML says HIGH or CRITICAL but metrics are OK, downgrade to MEDIUM
                if raw_risk_level in ["high", "critical"]:
                    is_on_budget = m["budget_efficiency"] <= 1.20
                    is_on_schedule = m["schedule_deviation"] <= 0.15
                    
                    if is_on_budget and is_on_schedule:
                        logger.info("prediction: Downgrading %s to MEDIUM for early mobilization", raw_risk_level)
                        
                        adjusted_result = ml_result.copy()
                        adjusted_result["risk_level"] = "medium"
                        adjusted_result["confidence"] = 0.70
                        adjusted_result["class_index"] = 1
                        adjusted_result["probabilities"] = {
                            "low": 0.20,
                            "medium": 0.70,
                            "high": 0.08,
                            "critical": 0.02
                        }
                        
                        return "medium", 0.70, "ml-adjusted", adjusted_result, features
            
            # For active projects (5+ logs) or if adjustments don't apply, use raw ML output
            return raw_risk_level, raw_confidence, "ml", ml_result, features
            
        logger.warning("prediction: ML predictor returned None, falling back to rule-based")
    else:
        logger.warning(
            "prediction: ML model NOT loaded (file missing at startup or load failed) — using rule-based fallback"
        )

    # Fallback to rule-based if ML fails
    level, confidence = _rule_based_risk(
        m["budget_efficiency"], m["schedule_deviation"], m["task_completion_rate"],
        m["remaining_days"], m["progress"]
    )
    logger.info("prediction: rule-based path — risk_level=%s confidence=%.2f", level, confidence)
    return level, confidence, "rule-based", None, {}


def _build_factors(project, m: dict, ml_result: dict | None, features: dict) -> dict:
    """Build user-friendly factors dict - only show relevant metrics"""
    factors = {
        "Progress": f"{project.progress_percentage:.1f}%",
        "Budget Used": f"{m['budget_ratio']*100:.1f}%",
        "Tasks Completed": f"{m['completed_tasks']}/{m['total_tasks']}",
        "Schedule Status": "Behind" if m["schedule_deviation"] > 0.05 else "On Track",
    }
    
    if m["delay_estimate_days"] > 0:
        factors["Estimated Delay"] = f"{m['delay_estimate_days']} days"
    
    if m["budget_overrun_estimate"] > 0:
        factors["Budget Risk"] = f"ETB {m['budget_overrun_estimate']:,.0f}"
    
    return factors


def _generate_insights(m: dict, risk_level: str, source: str = "ml") -> tuple[str, str]:
    """Generate human-readable reason and recommendation from metrics."""
    reasons = []
    recommendations = []
    
    # For adjusted predictions, provide context
    if source == "ml-adjusted":
        if risk_level == "low":
            reasons.append("Project is in planning phase with healthy financial metrics")
            recommendations.append("Continue planning activities and prepare for mobilization")
            return "; ".join(reasons), "; ".join(recommendations)

    if m["budget_efficiency"] > 1.2:
        reasons.append(f"Budget spending is {m['budget_efficiency']:.0%} of progress — overspending detected")
        recommendations.append("Review cost allocations and pause non-critical procurement")
    elif m["budget_efficiency"] > 1.0:
        reasons.append("Budget usage is slightly ahead of progress")
        recommendations.append("Monitor spending closely over the next reporting period")

    if m["schedule_deviation"] > 0.15:
        reasons.append(f"Project is {m['schedule_deviation']:.0%} behind expected schedule")
        recommendations.append("Consider adding resources or re-sequencing critical path tasks")
    elif m["schedule_deviation"] > 0.05:
        reasons.append("Minor schedule slippage detected")
        recommendations.append("Ensure pending tasks are unblocked and assigned")

    if m["total_tasks"] > 0 and m["task_completion_rate"] < 0.3:
        reasons.append(f"Only {m['task_completion_rate']:.0%} of tasks completed")
        recommendations.append("Prioritize completing in-progress tasks before starting new ones")

    if m["total_tasks"] == 0:
        reasons.append("No tasks created yet — risk assessment is limited")
        recommendations.append("Break down the project into tasks for better tracking")

    if not reasons:
        if risk_level == "low":
            reasons.append("Project is on track with healthy budget and schedule metrics")
            recommendations.append("Continue current pace and maintain regular daily log submissions")
        else:
            reasons.append("Multiple minor factors contributing to elevated risk")
            recommendations.append("Review project metrics and address any emerging bottlenecks")

    return "; ".join(reasons), "; ".join(recommendations)


@router.get("/{project_id}/prediction", response_model=RiskPredictionResponse, summary="Get risk prediction (ML/rule-based)")
async def get_risk_prediction(
    project_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> Any:
    """
    Risk + delay + budget-overrun prediction for a project.

    - `risk_level` and `confidence_score` come from the trained Random Forest classifier
    when the model is loaded; otherwise from a rule-based fallback.
    - `delay_estimate_days` and `budget_overrun_estimate` are always derived from
    project schedule/budget math.
    - Computed fresh on every request (no storage).
    """
    project = await project_repo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    m = await _compute_metrics(db, project)
    logger.info(
        "prediction: metrics — total_tasks=%d completed=%d progress=%.2f budget_ratio=%.3f schedule_dev=%.3f",
        m["total_tasks"], m["completed_tasks"], m["progress"], m["budget_ratio"], m["schedule_deviation"],
    )

    risk_level, confidence_score, source, ml_result, features = await _resolve_risk(db, project, m)
    factors = _build_factors(project, m, ml_result, features)
    reason, recommendation = _generate_insights(m, risk_level, source)

    # Risk-escalation alert — notify PM once when the level moves up vs. the last alerted level.
    # Order: low < medium < high < critical. Drops do not notify.
    risk_order = {"low": 0, "medium": 1, "high": 2, "critical": 3}
    last_alerted = project.last_alert_risk_level
    if (
        risk_level in risk_order
        and (last_alerted is None or risk_order[risk_level] > risk_order.get(last_alerted, -1))
        and risk_level != "low"  # don't notify when the project is healthy
    ):
        from app.models.project import ProjectMember
        from app.models.commons import ProjectRole as _PR
        from app.services.notifications import notify
        pm_rows = await db.execute(
            select(ProjectMember.user_id).where(
                ProjectMember.project_id == project_id,
                ProjectMember.role == _PR.PROJECT_MANAGER.value,
            )
        )
        for (uid,) in pm_rows.all():
            await notify(
                db, user_id=uid, type="risk_alert",
                content=f"Risk on project '{project.name}' rose to {risk_level}",
                entity_type="project", entity_id=project_id, project_id=project_id,
            )
        project.last_alert_risk_level = risk_level
        db.add(project)
        await db.commit()

    return RiskPredictionResponse(
        project_id=project_id,
        risk_level=risk_level,
        delay_estimate_days=m["delay_estimate_days"],
        budget_overrun_estimate=round(m["budget_overrun_estimate"], 2),
        confidence_score=round(confidence_score, 2),
        source=source,
        reason=reason,
        recommendation=recommendation,
        factors=factors,
    )



# ══════════════════════════════════════════════════════════════
# Advanced Analytics Endpoints
# ══════════════════════════════════════════════════════════════

@router.get("/{project_id}/prediction/trend", summary="Get risk trend over time")
async def get_risk_trend(
    project_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
    limit: int = 10,
) -> Any:
    """Get last N risk predictions to show trend line."""
    project = await project_repo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    trend_data = await analytics.get_risk_trend(db, project_id, limit)
    return {"project_id": str(project_id), "trend": trend_data}


@router.get("/{project_id}/analytics/schedule-health", summary="Schedule health index")
async def get_schedule_health(
    project_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> Any:
    """
    Schedule health index: (actual_progress / expected_progress) × 100
    Below 80 = warning, below 60 = critical
    """
    project = await project_repo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    result = await analytics.compute_schedule_health_index(db, project)
    return {"project_id": str(project_id), **result}


@router.get("/{project_id}/analytics/budget-efficiency", summary="Budget efficiency rate")
async def get_budget_efficiency(
    project_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> Any:
    """
    Budget efficiency: (progress / budget_consumed) × 100
    >100 = ahead, 90-100 = efficient, <90 = inefficient
    """
    project = await project_repo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    result = await analytics.compute_budget_efficiency_rate(db, project)
    return {"project_id": str(project_id), **result}


@router.get("/{project_id}/analytics/equipment-productivity", summary="Equipment productivity score")
async def get_equipment_productivity(
    project_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> Any:
    """Equipment productivity: productive hours vs paid hours."""
    project = await project_repo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    result = await analytics.compute_equipment_productivity_score(db, project_id)
    return {"project_id": str(project_id), **result}


@router.get("/{project_id}/analytics/weather-impact", summary="Weather impact accumulation")
async def get_weather_impact(
    project_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
    days: int = 30,
) -> Any:
    """Weather impact: hours lost over last N days."""
    project = await project_repo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    result = await analytics.compute_weather_impact_accumulation(db, project_id, days)
    return {"project_id": str(project_id), **result}


@router.get("/{project_id}/analytics/labor-productivity", summary="Labor productivity trend")
async def get_labor_productivity(
    project_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
    limit: int = 10,
) -> Any:
    """Labor productivity trend over last N logs."""
    project = await project_repo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    result = await analytics.compute_labor_productivity_trend(db, project_id, limit)
    return {"project_id": str(project_id), **result}


@router.get("/{project_id}/analytics/material-burn-rate", summary="Material cost burn rate")
async def get_material_burn_rate(
    project_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> Any:
    """Material burn rate and days until budget exhaustion."""
    project = await project_repo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    result = await analytics.compute_material_burn_rate(db, project, project_id)
    return {"project_id": str(project_id), **result}


@router.get("/{project_id}/analytics/risk-boundary", summary="Risk boundary distance")
async def get_risk_boundary(
    project_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> Any:
    """How far from next risk level and which parameter would push it over."""
    project = await project_repo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    # Get current prediction
    prediction = await get_risk_prediction(project_id, db, _)
    prediction_dict = {
        "risk_level": prediction.risk_level,
        "risk_probabilities": prediction.factors.get("ml_probabilities", {}),
        "factors": prediction.factors,
    }
    
    result = await analytics.compute_risk_boundary_distance(db, project_id, prediction_dict)
    return {"project_id": str(project_id), **result}


@router.get("/{project_id}/analytics/delay-breakdown", summary="Delay breakdown by cause")
async def get_delay_breakdown(
    project_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> Any:
    """Break down estimated delay by contributing factors."""
    project = await project_repo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    # Get current prediction
    prediction = await get_risk_prediction(project_id, db, _)
    prediction_dict = {
        "delay_estimate_days": prediction.delay_estimate_days,
        "factors": prediction.factors,
    }
    
    result = await analytics.compute_delay_breakdown(db, project, prediction_dict)
    return {"project_id": str(project_id), **result}


@router.get("/{project_id}/analytics/comprehensive", summary="Get all analytics at once")
async def get_comprehensive_analytics(
    project_id: UUID, db: DbSession,
    _: User = Depends(get_current_active_user),
) -> Any:
    """Get all analytics metrics in a single request for dashboard display."""
    project = await project_repo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    # Get current prediction
    prediction = await get_risk_prediction(project_id, db, _)
    prediction_dict = {
        "risk_level": prediction.risk_level,
        "risk_probabilities": prediction.factors.get("ml_probabilities", {}),
        "delay_estimate_days": prediction.delay_estimate_days,
        "factors": prediction.factors,
    }
    
    # Compute all analytics
    schedule_health = await analytics.compute_schedule_health_index(db, project)
    budget_efficiency = await analytics.compute_budget_efficiency_rate(db, project)
    equipment_productivity = await analytics.compute_equipment_productivity_score(db, project_id)
    weather_impact = await analytics.compute_weather_impact_accumulation(db, project_id, 30)
    labor_productivity = await analytics.compute_labor_productivity_trend(db, project_id, 10)
    material_burn = await analytics.compute_material_burn_rate(db, project, project_id)
    risk_boundary = await analytics.compute_risk_boundary_distance(db, project_id, prediction_dict)
    delay_breakdown = await analytics.compute_delay_breakdown(db, project, prediction_dict)
    risk_trend = await analytics.get_risk_trend(db, project_id, 10)
    
    return {
        "project_id": str(project_id),
        "prediction": {
            "risk_level": prediction.risk_level,
            "confidence_score": prediction.confidence_score,
            "delay_estimate_days": prediction.delay_estimate_days,
            "budget_overrun_estimate": prediction.budget_overrun_estimate,
            "source": prediction.source,
            "reason": prediction.reason,
            "recommendation": prediction.recommendation,
            "risk_probabilities": prediction.factors.get("ml_probabilities", {}),
        },
        "schedule_health": schedule_health,
        "budget_efficiency": budget_efficiency,
        "equipment_productivity": equipment_productivity,
        "weather_impact": weather_impact,
        "labor_productivity": labor_productivity,
        "material_burn_rate": material_burn,
        "risk_boundary": risk_boundary,
        "delay_breakdown": delay_breakdown,
        "risk_trend": risk_trend,
    }
