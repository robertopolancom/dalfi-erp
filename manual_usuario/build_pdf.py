from pathlib import Path
import re

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    Image,
    ListFlowable,
    ListItem,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
)


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "manual.md"
OUTPUT = ROOT / "manual.pdf"


def inline_markdown(text: str) -> str:
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"`(.+?)`", r"<font name='Courier'>\1</font>", text)
    return text


def scaled_image(path: Path, max_width: float, max_height: float):
    img = Image(str(path))
    ratio = min(max_width / img.imageWidth, max_height / img.imageHeight)
    img.drawWidth = max_width
    img.drawWidth = img.imageWidth * ratio
    img.drawHeight = img.imageHeight * ratio
    return img


def build():
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="ManualTitle",
            parent=styles["Title"],
            fontSize=22,
            leading=26,
            textColor=colors.HexColor("#202225"),
            spaceAfter=12,
        )
    )
    styles.add(
        ParagraphStyle(
            name="ManualH1",
            parent=styles["Heading1"],
            fontSize=18,
            leading=22,
            textColor=colors.HexColor("#0f766e"),
            spaceBefore=14,
            spaceAfter=8,
        )
    )
    styles.add(
        ParagraphStyle(
            name="ManualH2",
            parent=styles["Heading2"],
            fontSize=13,
            leading=16,
            textColor=colors.HexColor("#202225"),
            spaceBefore=10,
            spaceAfter=6,
        )
    )
    styles.add(
        ParagraphStyle(
            name="ManualBody",
            parent=styles["BodyText"],
            fontSize=9.5,
            leading=13,
            spaceAfter=6,
        )
    )
    styles.add(
        ParagraphStyle(
            name="ManualMeta",
            parent=styles["BodyText"],
            fontSize=9,
            leading=12,
            textColor=colors.HexColor("#6b6f76"),
            spaceAfter=10,
        )
    )

    doc = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=letter,
        rightMargin=0.55 * inch,
        leftMargin=0.55 * inch,
        topMargin=0.55 * inch,
        bottomMargin=0.55 * inch,
        title="Manual de uso - Dalfi Studio Nail & Academy ERP",
    )
    max_width = letter[0] - doc.leftMargin - doc.rightMargin
    max_height = letter[1] - doc.topMargin - doc.bottomMargin - 0.4 * inch
    story = []
    pending_list = []
    current_list_ordered = False

    def flush_list():
        nonlocal pending_list, current_list_ordered
        if not pending_list:
            return
        story.append(
            ListFlowable(
                [ListItem(Paragraph(inline_markdown(item), styles["ManualBody"])) for item in pending_list],
                bulletType="1" if current_list_ordered else "bullet",
                leftIndent=16,
            )
        )
        story.append(Spacer(1, 4))
        pending_list = []

    for raw_line in SOURCE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            flush_list()
            story.append(Spacer(1, 5))
            continue
        if line == "---":
            flush_list()
            story.append(Spacer(1, 8))
            continue
        image_match = re.match(r"!\[(.*?)\]\((.*?)\)", line)
        if image_match:
            flush_list()
            image_path = ROOT / image_match.group(2)
            if image_path.exists():
                story.append(scaled_image(image_path, max_width, max_height))
                story.append(Spacer(1, 10))
            continue
        if line.startswith("# "):
            flush_list()
            story.append(Paragraph(inline_markdown(line[2:]), styles["ManualTitle"]))
            continue
        if line.startswith("## "):
            flush_list()
            title = line[3:]
            if title.startswith(("1.", "2.", "3.", "4.", "5.", "6.", "7.", "8.", "9.", "10.", "11.", "12.", "13.", "14.")) and story:
                story.append(PageBreak())
            story.append(Paragraph(inline_markdown(title), styles["ManualH1"]))
            continue
        if line.startswith("### "):
            flush_list()
            story.append(Paragraph(inline_markdown(line[4:]), styles["ManualH2"]))
            continue
        ordered = re.match(r"^\d+\.\s+(.*)", line)
        unordered = re.match(r"^\*\s+(.*)", line)
        if ordered or unordered:
            item = (ordered or unordered).group(1)
            list_ordered = bool(ordered)
            if pending_list and list_ordered != current_list_ordered:
                flush_list()
            current_list_ordered = list_ordered
            pending_list.append(item)
            continue
        flush_list()
        style = styles["ManualMeta"] if line.startswith(("Fecha de elaboración:", "Aplicación:", "URL local")) else styles["ManualBody"]
        story.append(Paragraph(inline_markdown(line), style))

    flush_list()
    doc.build(story)


if __name__ == "__main__":
    build()
