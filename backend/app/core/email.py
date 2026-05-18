import smtplib
from email.message import EmailMessage
import logging
import httpx
from app.core.config import settings

logger = logging.getLogger(__name__)

RESEND_API_URL = "https://api.resend.com/emails"


def send_invitation_email(to_email: str, project_name: str, token: str, user_exists: bool = False) -> bool:
    if user_exists:
        subject = f"You've been added to project: {project_name}"
        body = (
            f"You've been added to the project: {project_name}.\n\n"
            f"Log in to access the project in your dashboard:\n"
            f"{settings.FRONTEND_URL}/login?email={to_email}\n"
        )
    else:
        subject = f"You've been invited to join: {project_name}"
        body = (
            f"You've been invited to join the project: {project_name}.\n\n"
            f"Sign up with this email address to get started:\n"
            f"{settings.FRONTEND_URL}/signup?email={to_email}\n\n"
            f"Once you create your account, you'll be automatically added to the project.\n"
        )

    return _dispatch(to_email, subject, body, context=f"invitation to {to_email}", token=token)


def send_password_reset_email(to_email: str, token: str) -> bool:
    reset_link = f"{settings.FRONTEND_URL}/reset-password?token={token}"
    subject = "Reset your password — Foresite"
    body = (
        f"You requested a password reset for your Foresite account.\n\n"
        f"Click the link below to set a new password (expires in 15 minutes):\n"
        f"{reset_link}\n\n"
        f"If you didn't request this, you can safely ignore this email.\n"
    )

    return _dispatch(to_email, subject, body, context=f"password reset to {to_email}", token=token)


def _dispatch(to_email: str, subject: str, body: str, context: str, token: str) -> bool:
    if settings.RESEND_API_KEY:
        try:
            _send_resend(to_email, subject, body)
            logger.info(f"Successfully sent {context} via Resend")
            return True
        except Exception as e:
            logger.error(f"Resend failed for {context}: {str(e)}")
            return False

    if settings.SMTP_HOST and settings.SMTP_PORT and settings.SMTP_EMAIL:
        try:
            _send_smtp(to_email, subject, body)
            logger.info(f"Successfully sent {context} via SMTP")
            return True
        except Exception as e:
            logger.error(f"SMTP failed for {context}: {str(e)}")
            return False

    logger.warning(f"No email transport configured. Skipping {context}. Token: {token}")
    return False


def _send_resend(to_email: str, subject: str, body: str) -> None:
    payload = {
        "from": settings.RESEND_FROM_EMAIL,
        "to": [to_email],
        "subject": subject,
        "text": body,
    }
    headers = {
        "Authorization": f"Bearer {settings.RESEND_API_KEY}",
        "Content-Type": "application/json",
    }
    with httpx.Client(timeout=10.0) as client:
        resp = client.post(RESEND_API_URL, json=payload, headers=headers)
        resp.raise_for_status()


def _send_smtp(to_email: str, subject: str, body: str) -> None:
    msg = EmailMessage()
    msg['From'] = settings.SMTP_EMAIL
    msg['To'] = to_email
    msg['Subject'] = subject
    msg.set_content(body)

    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as server:
        server.starttls()
        if settings.SMTP_PASSWORD:
            server.login(settings.SMTP_EMAIL, settings.SMTP_PASSWORD)
        server.send_message(msg)
