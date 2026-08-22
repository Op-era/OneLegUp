#!/usr/bin/env python3
"""Generate One Leg Up Club Owner Partnership pitch PDF."""

from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    HRFlowable,
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
)

OUTPUT = Path(__file__).resolve().parent / "OneLegUp-Club-Owner-Partnership-Pitch.pdf"

GOLD = HexColor("#f3c675")
DARK_BG = HexColor("#080808")
DARK_PANEL = HexColor("#121212")
TEXT = HexColor("#e8e8e8")
TEXT_MUTED = HexColor("#b0b0b0")
ACCENT_LINE = HexColor("#3a3020")


def draw_page_background(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(DARK_BG)
    canvas.rect(0, 0, letter[0], letter[1], fill=1, stroke=0)
    canvas.setFillColor(DARK_PANEL)
    canvas.roundRect(
        0.55 * inch,
        0.55 * inch,
        letter[0] - 1.1 * inch,
        letter[1] - 1.1 * inch,
        8,
        fill=1,
        stroke=0,
    )
    canvas.setStrokeColor(ACCENT_LINE)
    canvas.setLineWidth(0.75)
    canvas.roundRect(
        0.55 * inch,
        0.55 * inch,
        letter[0] - 1.1 * inch,
        letter[1] - 1.1 * inch,
        8,
        fill=0,
        stroke=1,
    )
    canvas.restoreState()


def build_styles():
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "Title",
            parent=base["Normal"],
            fontName="Helvetica-Bold",
            fontSize=22,
            leading=28,
            textColor=GOLD,
            alignment=TA_CENTER,
            spaceAfter=6,
        ),
        "subtitle": ParagraphStyle(
            "Subtitle",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=11,
            leading=15,
            textColor=TEXT_MUTED,
            alignment=TA_CENTER,
            spaceAfter=14,
        ),
        "h2": ParagraphStyle(
            "H2",
            parent=base["Normal"],
            fontName="Helvetica-Bold",
            fontSize=12.5,
            leading=16,
            textColor=GOLD,
            spaceBefore=10,
            spaceAfter=6,
        ),
        "body": ParagraphStyle(
            "Body",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=10,
            leading=14,
            textColor=TEXT,
            alignment=TA_LEFT,
            spaceAfter=6,
        ),
        "bullet": ParagraphStyle(
            "Bullet",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=10,
            leading=14,
            textColor=TEXT,
            leftIndent=14,
            bulletIndent=0,
            spaceAfter=4,
        ),
        "step": ParagraphStyle(
            "Step",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=10,
            leading=14,
            textColor=TEXT,
            leftIndent=14,
            spaceAfter=4,
        ),
        "cta": ParagraphStyle(
            "CTA",
            parent=base["Normal"],
            fontName="Helvetica-Bold",
            fontSize=10.5,
            leading=14,
            textColor=GOLD,
            spaceAfter=4,
        ),
        "footer": ParagraphStyle(
            "Footer",
            parent=base["Normal"],
            fontName="Helvetica-Oblique",
            fontSize=9,
            leading=12,
            textColor=TEXT_MUTED,
            alignment=TA_CENTER,
            spaceBefore=8,
        ),
    }


def section(styles, title, paragraphs=None, bullets=None, steps=None):
    flow = [Paragraph(title, styles["h2"])]
    flow.append(
        HRFlowable(
            width="100%",
            thickness=0.5,
            color=ACCENT_LINE,
            spaceBefore=0,
            spaceAfter=8,
        )
    )
    if paragraphs:
        for p in paragraphs:
            flow.append(Paragraph(p, styles["body"]))
    if bullets:
        for b in bullets:
            flow.append(Paragraph(f"• {b}", styles["bullet"]))
    if steps:
        for i, s in enumerate(steps, 1):
            flow.append(Paragraph(f"{i}. {s}", styles["step"]))
    flow.append(Spacer(1, 4))
    return flow


def main():
    styles = build_styles()
    story = []

    story.append(Spacer(1, 0.15 * inch))
    story.append(Paragraph("One Leg Up — Club Owner Partnership", styles["title"]))
    story.append(
        Paragraph(
            "A complimentary listing program for Fresno-area lifestyle club hosts",
            styles["subtitle"],
        )
    )
    story.append(Spacer(1, 0.05 * inch))

    story.extend(
        section(
            styles,
            "Who We Are",
            paragraphs=[
                "One Leg Up hosts elegant lifestyle parties in the Fresno and Central Valley area. "
                "Our website, <link href='https://onelegup.club' color='#f3c675'>onelegup.club</link>, "
                "is the membership and RSVP hub where guests discover upcoming nights out, RSVP, and "
                "stay connected with the local lifestyle community.",
                "We know that great evenings often start with trusted hosts and well-run clubs. "
                "This partnership program is designed to help those hosts reach the right audience "
                "without adding cost or complexity.",
            ],
        )
    )

    story.extend(
        section(
            styles,
            "The Offer",
            paragraphs=[
                "We are inviting selected club owners and hosts in the Fresno area to join as "
                "<b>Club Owner partners</b> with a <b>free Club Owner account</b>.",
                "There is no monthly fee for partner club owners. This is a complimentary pilot "
                "for hosts we believe align with the tone and standards of the One Leg Up community.",
            ],
        )
    )

    story.extend(
        section(
            styles,
            "What You Get",
            bullets=[
                "<b>Club Owner Panel</b> — A dedicated dashboard where you publish your own event listings on onelegup.club.",
                "<b>Party posters and flyers</b> — Upload artwork for each event so it appears as an upcoming party on the public site.",
                "<b>Built-in audience</b> — Reach guests who are already browsing One Leg Up when they plan their next night out.",
                "<b>No monthly fee</b> — Partner club owner accounts are free for the duration of this program.",
            ],
            paragraphs=[
                "Your listings appear alongside One Leg Up events, giving your club visibility with "
                "an audience that is already interested in lifestyle social events in the region.",
            ],
        )
    )

    story.extend(
        section(
            styles,
            "How It Works",
            steps=[
                "<b>Invitation</b> — Shane (One Leg Up admin) sends you a personal email invitation to join as a Club Owner partner.",
                "<b>Set your password</b> — Our email system (Resend) delivers a secure set-password link so you can activate your account.",
                "<b>Log in</b> — You sign in to the <b>Club Owner Panel</b> on onelegup.club.",
                "<b>Create your listing</b> — Add your party with a title, date, description, and poster or flyer image.",
                "<b>Go live</b> — Your event listing publishes on the public site for guests to discover.",
            ],
            paragraphs=[
                "The process is straightforward. Most hosts can publish their first listing in a few minutes after accepting the invitation.",
            ],
        )
    )

    story.extend(
        section(
            styles,
            "What We Ask in Return",
            paragraphs=[
                "We keep the platform welcoming, accurate, and respectful. As a partner, we ask that you:",
            ],
            bullets=[
                "Publish <b>accurate listings</b> with clear dates, locations (as appropriate), dress codes, and entry details.",
                "Use <b>tasteful posters and flyers</b> that reflect well on your club and on the One Leg Up community.",
                "<b>Respect guest privacy and consent culture</b> — the standards our members expect at every event we promote.",
                "<b>Avoid spam</b> — no bulk messaging, misleading promotions, or repeated low-quality posts.",
            ],
        )
    )
    story.append(
        Paragraph(
            "We review partner listings and reserve the right to pause or remove accounts that do not meet these expectations.",
            styles["body"],
        )
    )

    story.extend(
        section(
            styles,
            "Let's Talk",
            paragraphs=[
                "We would welcome a short conversation about your next event and whether a free pilot listing on onelegup.club makes sense for your club.",
            ],
        )
    )
    story.append(Paragraph("Website: https://onelegup.club", styles["cta"]))
    story.append(Paragraph("Email: hautcouple@gmail.com", styles["cta"]))
    story.append(Paragraph("Phone / text: 559-787-5801", styles["cta"]))
    story.append(Spacer(1, 6))
    story.append(
        Paragraph(
            "Reply by email or text, and we can set up your free Club Owner account and walk you through your first listing together.",
            styles["body"],
        )
    )
    story.append(
        Paragraph(
            "One Leg Up — elegant lifestyle events in the Fresno and Central Valley area.",
            styles["footer"],
        )
    )

    doc = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=letter,
        leftMargin=0.85 * inch,
        rightMargin=0.85 * inch,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
        title="One Leg Up — Club Owner Partnership",
        author="One Leg Up",
    )
    doc.build(story, onFirstPage=draw_page_background, onLaterPages=draw_page_background)

    from PyPDF2 import PdfReader

    pages = len(PdfReader(str(OUTPUT)).pages)
    print(f"Wrote {OUTPUT} ({pages} page{'s' if pages != 1 else ''})")


if __name__ == "__main__":
    main()
