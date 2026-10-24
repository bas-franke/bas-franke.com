import {
  PDFDocument,
  PDFString,
  StandardFonts,
  appendBezierCurve,
  clip,
  closePath,
  endPath,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type RGB,
} from 'pdf-lib';
import { experience, resume, site, skills, type Experience } from './content';

/**
 * Builds the résumé PDF from content.ts, so it can never go out of step with the site.
 *
 * Pure layout: the images arrive as bytes (resumeDownload.ts fetches them through Vite), so this
 * module also runs under plain Node for a quick look at the result. A4, white paper, the site's ink
 * and lake blue. One column: the company marks sit on a timeline beside the jobs, the skills are
 * chips next to a level meter, the principles sit in two columns.
 */

export interface ResumeAssets {
  /** Square JPEG portrait, shown as a circle in the header. Leave out for a text-only header. */
  photo?: Uint8Array;
  /** PNG company marks by experience slug (src/art/logos/<slug>.png). Missing ones get a monogram tile. */
  logos: Partial<Record<string, Uint8Array>>;
}

const PAGE = { width: 595.28, height: 841.89 }; // A4 in points
const MARGIN = 52;
const RIGHT = PAGE.width - MARGIN;
const CONTENT_WIDTH = RIGHT - MARGIN;
const FOOTER_ROOM = 30;

// The site's palette (styles.css) on white paper.
const INK = rgb(0.106, 0.114, 0.11);
const INK_2 = rgb(0.294, 0.306, 0.294);
const INK_3 = rgb(0.431, 0.443, 0.427);
const LINE = rgb(0.851, 0.831, 0.788);
const LINE_2 = rgb(0.769, 0.745, 0.694);
const PAPER_2 = rgb(0.925, 0.91, 0.878);
const ACCENT = rgb(0.31, 0.42, 0.486);
const ACCENT_SOFT = rgb(0.904, 0.919, 0.928);

const CHIP = { height: 13, padding: 6, gap: 4, size: 7.5 };
const MARK = 22; // company mark, square
const GUTTER = 36; // column left of the jobs that holds the marks and the timeline
const PHOTO = { diameter: 64, focusX: 0.31, focusY: 0.4, zoom: 2.1 }; // where the face is in profile.jpg

interface Fonts {
  sans: PDFFont;
  bold: PDFFont;
  serif: PDFFont;
}

interface Chip {
  text: string;
  width: number;
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || font.widthOfTextAtSize(candidate, size) <= maxWidth) current = candidate;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** SVG path of a rounded rectangle with its top-left corner at the origin, y pointing down. */
function roundedRectPath(w: number, h: number, r: number): string {
  const k = 0.5523 * r;
  const n = (v: number) => v.toFixed(2);
  return [
    `M ${n(r)} 0 L ${n(w - r)} 0`,
    `C ${n(w - r + k)} 0 ${n(w)} ${n(r - k)} ${n(w)} ${n(r)}`,
    `L ${n(w)} ${n(h - r)}`,
    `C ${n(w)} ${n(h - r + k)} ${n(w - r + k)} ${n(h)} ${n(w - r)} ${n(h)}`,
    `L ${n(r)} ${n(h)}`,
    `C ${n(r - k)} ${n(h)} 0 ${n(h - r + k)} 0 ${n(h - r)}`,
    `L 0 ${n(r)}`,
    `C 0 ${n(r - k)} ${n(r - k)} 0 ${n(r)} 0 Z`,
  ].join(' ');
}

/** Lays chips out in rows that fit `maxWidth`. */
function chipRows(items: string[], font: PDFFont, maxWidth: number): Chip[][] {
  const rows: Chip[][] = [[]];
  let used = 0;
  for (const text of items) {
    const width = font.widthOfTextAtSize(text, CHIP.size) + CHIP.padding * 2;
    const row = rows[rows.length - 1];
    if (row.length > 0 && used + CHIP.gap + width > maxWidth) {
      rows.push([{ text, width }]);
      used = width;
    } else {
      row.push({ text, width });
      used += (row.length > 1 ? CHIP.gap : 0) + width;
    }
  }
  return rows;
}

function chipsHeight(rows: Chip[][]): number {
  return rows.length * CHIP.height + (rows.length - 1) * CHIP.gap;
}

/** The pages, a cursor that moves down them, and the drawing primitives the sections share. */
class Sheet {
  readonly doc: PDFDocument;
  readonly fonts: Fonts;
  readonly marks: Partial<Record<string, PDFImage>>;
  page: PDFPage;
  /** Top of the next thing to draw, in PDF coordinates (y grows upwards). */
  y: number;

  constructor(doc: PDFDocument, fonts: Fonts, marks: Partial<Record<string, PDFImage>>) {
    this.doc = doc;
    this.fonts = fonts;
    this.marks = marks;
    this.page = doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
  }

  /** Starts a new page unless `height` points still fit above the footer. True when it did. */
  ensure(height: number): boolean {
    if (this.y - height >= MARGIN + FOOTER_ROOM) return false;
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
    return true;
  }

  text(text: string, x: number, baseline: number, font: PDFFont, size: number, color: RGB) {
    this.page.drawText(text, { x, y: baseline, size, font, color });
  }

  textRight(text: string, right: number, baseline: number, font: PDFFont, size: number, color: RGB) {
    this.text(text, right - font.widthOfTextAtSize(text, size), baseline, font, size, color);
  }

  /** Text that opens `url` when clicked; the link area is invisible, the text looks like any other. */
  textLink(text: string, x: number, baseline: number, font: PDFFont, size: number, color: RGB, url: string) {
    this.text(text, x, baseline, font, size, color);
    const annotation = this.doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [x, baseline - size * 0.3, x + font.widthOfTextAtSize(text, size), baseline + size],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
    });
    this.page.node.addAnnot(this.doc.context.register(annotation));
  }

  /** Letter-spaced text (pdf-lib has no tracking option). Returns the width drawn. */
  tracked(text: string, x: number, baseline: number, font: PDFFont, size: number, color: RGB, tracking: number): number {
    let cursor = x;
    for (const ch of text) {
      this.text(ch, cursor, baseline, font, size, color);
      cursor += font.widthOfTextAtSize(ch, size) + tracking;
    }
    return cursor - tracking - x;
  }

  hairline(x1: number, x2: number, y: number, color: RGB = LINE, thickness = 0.6) {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }

  rounded(x: number, top: number, width: number, height: number, radius: number, color: RGB) {
    this.page.drawSvgPath(roundedRectPath(width, height, radius), { x, y: top, color, borderWidth: 0 });
  }

  /** A wrapped block of text starting at the cursor, which moves below it. Breaks pages between lines. */
  paragraph(text: string, x: number, width: number, font: PDFFont, size: number, color: RGB, lineHeight: number) {
    for (const line of wrap(text, font, size, width)) {
      this.ensure(lineHeight);
      this.y -= lineHeight;
      this.text(line, x, this.y, font, size, color);
    }
  }

  /** Section label in letter-spaced small capitals, with a hairline running out to the right margin. */
  section(label: string) {
    this.ensure(80);
    this.y -= 24;
    const size = 7.5;
    const baseline = this.y - size;
    const width = this.tracked(label.toUpperCase(), MARGIN, baseline, this.fonts.bold, size, ACCENT, 1.5);
    this.hairline(MARGIN + width + 10, RIGHT, baseline + size * 0.36);
    this.y = baseline - 10;
  }

  /** Rows of pill-shaped chips, top-left at (x, top). Returns the height used. */
  chips(rows: Chip[][], x: number, top: number, fill: RGB, color: RGB): number {
    let rowTop = top;
    for (const row of rows) {
      let cursor = x;
      for (const chip of row) {
        this.rounded(cursor, rowTop, chip.width, CHIP.height, CHIP.height / 2, fill);
        this.text(chip.text, cursor + CHIP.padding, rowTop - CHIP.height + 4, this.fonts.sans, CHIP.size, color);
        cursor += chip.width + CHIP.gap;
      }
      rowTop -= CHIP.height + CHIP.gap;
    }
    return chipsHeight(rows);
  }

  /** Company mark: the logo when there is one, otherwise a soft tile with the company's initial. */
  mark(job: Experience, x: number, top: number) {
    const image = this.marks[job.slug];
    if (image) {
      this.page.drawImage(image, { x, y: top - MARK, width: MARK, height: MARK });
      return;
    }
    this.rounded(x, top, MARK, MARK, 5, ACCENT_SOFT);
    const initial = job.company.charAt(0).toUpperCase();
    const size = 10.5;
    const width = this.fonts.bold.widthOfTextAtSize(initial, size);
    this.text(initial, x + (MARK - width) / 2, top - MARK / 2 - size * 0.36, this.fonts.bold, size, ACCENT);
  }

  /** Four short bars, `level` of them filled. Returns the width drawn. */
  meter(x: number, baseline: number, level: number, steps = 4): number {
    const w = 11;
    const h = 4;
    const gap = 3;
    for (let i = 0; i < steps; i++) {
      this.rounded(x + i * (w + gap), baseline + h, w, h, h / 2, i < level ? ACCENT : LINE);
    }
    return steps * (w + gap) - gap;
  }

  /** The portrait, cropped to a circle around the face, with a hairline ring. */
  portrait(image: PDFImage, cx: number, cy: number) {
    const r = PHOTO.diameter / 2;
    const k = 0.5523 * r;
    this.page.pushOperators(
      pushGraphicsState(),
      moveTo(cx + r, cy),
      appendBezierCurve(cx + r, cy + k, cx + k, cy + r, cx, cy + r),
      appendBezierCurve(cx - k, cy + r, cx - r, cy + k, cx - r, cy),
      appendBezierCurve(cx - r, cy - k, cx - k, cy - r, cx, cy - r),
      appendBezierCurve(cx + k, cy - r, cx + r, cy - k, cx + r, cy),
      closePath(),
      clip(),
      endPath(),
    );
    const size = PHOTO.diameter * PHOTO.zoom;
    this.page.drawImage(image, {
      x: cx - PHOTO.focusX * size,
      y: cy - (1 - PHOTO.focusY) * size,
      width: size,
      height: size,
    });
    this.page.pushOperators(popGraphicsState());
    this.page.drawCircle({ x: cx, y: cy, size: r, borderColor: LINE_2, borderWidth: 0.8 });
  }
}

function header(s: Sheet, photo: PDFImage | undefined) {
  const top = s.y;
  let x = MARGIN;
  if (photo) {
    s.portrait(photo, MARGIN + PHOTO.diameter / 2, top - PHOTO.diameter / 2);
    x = MARGIN + PHOTO.diameter + 18;
  }
  s.text(site.name, x, top - 26, s.fonts.serif, 27, INK);
  s.text(resume.title, x, top - 44, s.fonts.sans, 10.5, INK_2);

  const contact: [string, string | undefined][] = [
    [site.email, `mailto:${site.email}`],
    [site.phone, undefined],
    [site.location, undefined],
    [site.url.replace(/^https?:\/\//, ''), site.url],
  ];
  contact.forEach(([line, url], i) => {
    const size = 8.5;
    const x = RIGHT - s.fonts.sans.widthOfTextAtSize(line, size);
    const baseline = top - 9 - i * 12.5;
    if (url) s.textLink(line, x, baseline, s.fonts.sans, size, INK_2, url);
    else s.text(line, x, baseline, s.fonts.sans, size, INK_2);
  });

  const rule = top - PHOTO.diameter - 14;
  s.hairline(MARGIN, RIGHT, rule, ACCENT, 0.8);
  s.y = rule - 2; // the first section adds its own spacing
}

function profileSection(s: Sheet) {
  s.section(resume.sections.profile);
  s.paragraph(resume.summary, MARGIN, CONTENT_WIDTH, s.fonts.sans, 9.8, INK_2, 14.2);
}

function experienceSection(s: Sheet) {
  s.section(resume.sections.experience);
  const x = MARGIN + GUTTER;
  const width = CONTENT_WIDTH - GUTTER;
  const size = 9.5;
  const lead = 13.2;
  let previous: { page: PDFPage; bottom: number } | undefined;

  for (const job of experience) {
    const lines = wrap(job.summary, s.fonts.sans, size, width);
    const rows = chipRows(job.tags, s.fonts.sans, width);
    const height = 11 + 13 + 4 + lines.length * lead + 7 + chipsHeight(rows);
    if (s.ensure(height + 8)) previous = undefined;
    const top = s.y;

    // The timeline: a thread from the previous mark down to this one, for the dated jobs.
    if (previous && job.period && previous.page === s.page) {
      const cx = MARGIN + MARK / 2;
      s.page.drawLine({ start: { x: cx, y: previous.bottom - 5 }, end: { x: cx, y: top + 5 }, thickness: 0.8, color: LINE_2 });
    }
    s.mark(job, MARGIN, top);

    s.y = top - 11;
    if (job.href) s.textLink(job.company, x, s.y, s.fonts.bold, 11, INK, job.href);
    else s.text(job.company, x, s.y, s.fonts.bold, 11, INK);
    if (job.period) s.textRight(job.period, RIGHT, s.y, s.fonts.sans, 8.5, INK_3);
    s.y -= 13;
    s.text([job.role, job.location].filter(Boolean).join('  ·  '), x, s.y, s.fonts.sans, 9.5, INK_2);
    s.y -= 4;
    for (const line of lines) {
      s.y -= lead;
      s.text(line, x, s.y, s.fonts.sans, size, INK_2);
    }
    s.y -= 7;
    s.y -= s.chips(rows, x, s.y, PAPER_2, INK_2);
    s.y -= 16;
    previous = { page: s.page, bottom: top - MARK };
  }
}

function skillsSection(s: Sheet) {
  s.section(resume.sections.skills);
  const labelWidth = 150;
  const x = MARGIN + labelWidth;
  const width = CONTENT_WIDTH - labelWidth;

  for (const tier of skills.tiers) {
    const rows = chipRows(tier.items, s.fonts.sans, width);
    const height = Math.max(chipsHeight(rows), 28);
    s.ensure(height + 12);
    const top = s.y;
    s.text(tier.name, MARGIN, top - 10, s.fonts.bold, 9.5, INK);
    const meterWidth = s.meter(MARGIN, top - 24, tier.level);
    s.text(tier.note, MARGIN + meterWidth + 8, top - 24, s.fonts.sans, 8, INK_3);
    s.chips(rows, x, top, ACCENT_SOFT, INK_2);
    s.y = top - height - 14;
  }
}

function approachSection(s: Sheet) {
  s.section(resume.sections.approach);
  const gap = 24;
  const numeral = 22;
  const columnWidth = (CONTENT_WIDTH - gap) / 2;
  const size = 9;
  const lead = 12.5;
  const items = skills.principles;

  for (let i = 0; i < items.length; i += 2) {
    const pair = items.slice(i, i + 2).map((p) => ({ ...p, lines: wrap(p.text, s.fonts.sans, size, columnWidth - numeral) }));
    const height = 13 + Math.max(...pair.map((p) => p.lines.length)) * lead;
    s.ensure(height + 12);
    const top = s.y;
    pair.forEach((p, j) => {
      const x = MARGIN + j * (columnWidth + gap);
      s.text(String(i + j + 1).padStart(2, '0'), x, top - 10, s.fonts.bold, 7.5, ACCENT);
      s.text(p.title, x + numeral, top - 10, s.fonts.bold, 9.5, INK);
      p.lines.forEach((line, k) => s.text(line, x + numeral, top - 23 - k * lead, s.fonts.sans, size, INK_2));
    });
    s.y = top - height - 12;
  }
}

function footer(doc: PDFDocument, fonts: Fonts) {
  const pages = doc.getPages();
  const stamp = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const left = `${site.name}   ·   ${site.url.replace(/^https?:\/\//, '')}   ·   ${stamp}`;
  pages.forEach((page, i) => {
    const right = `Page ${i + 1} of ${pages.length}`;
    const width = fonts.sans.widthOfTextAtSize(right, 7.5);
    page.drawLine({ start: { x: MARGIN, y: MARGIN - 10 }, end: { x: RIGHT, y: MARGIN - 10 }, thickness: 0.5, color: LINE });
    page.drawText(left, { x: MARGIN, y: MARGIN - 24, size: 7.5, font: fonts.sans, color: INK_3 });
    page.drawText(right, { x: RIGHT - width, y: MARGIN - 24, size: 7.5, font: fonts.sans, color: INK_3 });
  });
}

export async function buildResume(assets: ResumeAssets): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${site.name} – Résumé`);
  doc.setAuthor(site.name);
  doc.setSubject(resume.title);
  doc.setCreator(site.url);

  const fonts: Fonts = {
    sans: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    serif: await doc.embedFont(StandardFonts.TimesRoman),
  };
  const marks: Partial<Record<string, PDFImage>> = {};
  for (const job of experience) {
    const bytes = assets.logos[job.slug];
    if (bytes) marks[job.slug] = await doc.embedPng(bytes);
  }
  const photo = assets.photo ? await doc.embedJpg(assets.photo) : undefined;

  const s = new Sheet(doc, fonts, marks);
  header(s, photo);
  profileSection(s);
  experienceSection(s);
  skillsSection(s);
  approachSection(s);
  footer(doc, fonts);

  return doc.save();
}
