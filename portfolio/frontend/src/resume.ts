import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { experience, resume, site, skills } from './content';

/**
 * Builds the résumé PDF from content.ts, so it can never go out of step with the site.
 * Plain white A4 page, classic layout: section labels in a narrow left column, text on the right.
 */

const PAGE = { width: 595.28, height: 841.89 }; // A4 in points
const MARGIN = 54;
const LABEL_WIDTH = 112;
const CONTENT_X = MARGIN + LABEL_WIDTH;
const CONTENT_WIDTH = PAGE.width - MARGIN - CONTENT_X;
const FOOTER_ROOM = 28;

const INK = rgb(0.11, 0.11, 0.11);
const GREY = rgb(0.42, 0.43, 0.42);
const RULE = rgb(0.84, 0.82, 0.78);
const ACCENT = rgb(0.31, 0.42, 0.49);

interface Fonts {
  serif: PDFFont;
  sans: PDFFont;
  sansBold: PDFFont;
}

interface TextStyle {
  font: PDFFont;
  size: number;
  color?: ReturnType<typeof rgb>;
  lineHeight?: number;
  after?: number;
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

class Layout {
  page: PDFPage;
  y: number;

  constructor(private readonly doc: PDFDocument) {
    this.page = doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
  }

  /** Starts a new page when `height` points no longer fit above the footer. */
  ensure(height: number) {
    if (this.y - height < MARGIN + FOOTER_ROOM) {
      this.page = this.doc.addPage([PAGE.width, PAGE.height]);
      this.y = PAGE.height - MARGIN;
    }
  }

  space(height: number) {
    this.y -= height;
  }

  rule(color = RULE, thickness = 0.6) {
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE.width - MARGIN, y: this.y },
      thickness,
      color,
    });
  }

  /** One wrapped block of text in the content column. */
  paragraph(text: string, { font, size, color = INK, lineHeight = size * 1.45, after = 0 }: TextStyle) {
    for (const line of wrap(text, font, size, CONTENT_WIDTH)) {
      this.ensure(lineHeight);
      this.y -= lineHeight;
      this.page.drawText(line, { x: CONTENT_X, y: this.y, size, font, color });
    }
    this.y -= after;
  }

  /** A section label in the left column, aligned with the first line of what follows. */
  section(label: string) {
    this.ensure(64);
    this.space(20);
    this.rule();
    this.space(16);
    this.page.drawText(label.toUpperCase(), { x: MARGIN, y: this.y - 13, size: 7.5, font: this.fonts.sansBold, color: ACCENT });
  }

  fonts!: Fonts;
}

export async function buildResume(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${site.name} – Résumé`);
  doc.setAuthor(site.name);
  doc.setSubject(resume.title);
  doc.setCreator(site.url);

  const fonts: Fonts = {
    serif: await doc.embedFont(StandardFonts.TimesRoman),
    sans: await doc.embedFont(StandardFonts.Helvetica),
    sansBold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const l = new Layout(doc);
  l.fonts = fonts;

  // Header: name, title, contact line, accent rule.
  l.space(26);
  l.page.drawText(site.name, { x: MARGIN, y: l.y, size: 26, font: fonts.serif, color: INK });
  l.space(20);
  l.page.drawText(resume.title, { x: MARGIN, y: l.y, size: 11, font: fonts.sans, color: GREY });
  l.space(15);
  const contact = [site.email, site.phone, site.location, site.url.replace(/^https?:\/\//, '')].join('   ·   ');
  l.page.drawText(contact, { x: MARGIN, y: l.y, size: 9, font: fonts.sans, color: GREY });
  l.space(16);
  l.rule(ACCENT, 1);
  l.space(-20); // the first section adds its own spacing and rule

  l.section(resume.sections.profile);
  l.paragraph(resume.summary, { font: fonts.sans, size: 10 });

  l.section(resume.sections.experience);
  for (const job of experience) {
    l.ensure(56);
    l.paragraph(`${job.company}  —  ${job.role}`, { font: fonts.sansBold, size: 11, lineHeight: 15 });
    const meta = [job.period, job.location].filter(Boolean).join('   ·   ');
    if (meta) l.paragraph(meta, { font: fonts.sans, size: 9, color: GREY, lineHeight: 12, after: 2 });
    l.paragraph(job.summary, { font: fonts.sans, size: 9.5, lineHeight: 13 });
    l.paragraph(job.tags.join('  ·  '), { font: fonts.sans, size: 8.5, color: GREY, lineHeight: 13, after: 8 });
  }

  l.section(resume.sections.skills);
  for (const tier of skills.tiers) {
    l.ensure(30);
    l.paragraph(`${tier.name}  —  ${tier.note}`, { font: fonts.sansBold, size: 9.5, lineHeight: 14 });
    l.paragraph(tier.items.join('  ·  '), { font: fonts.sans, size: 9.5, lineHeight: 13, after: 6 });
  }

  l.section(resume.sections.approach);
  for (const principle of skills.principles) {
    l.ensure(36);
    l.paragraph(principle.title, { font: fonts.sansBold, size: 10, lineHeight: 14 });
    l.paragraph(principle.text, { font: fonts.sans, size: 9.5, color: GREY, lineHeight: 13, after: 6 });
  }

  // Footer on every page.
  const pages = doc.getPages();
  const stamp = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const left = `${site.name}   ·   ${site.url.replace(/^https?:\/\//, '')}   ·   ${stamp}`;
  pages.forEach((page, i) => {
    const right = `Page ${i + 1} of ${pages.length}`;
    const width = fonts.sans.widthOfTextAtSize(right, 8);
    page.drawText(left, { x: MARGIN, y: MARGIN - 18, size: 8, font: fonts.sans, color: GREY });
    page.drawText(right, { x: PAGE.width - MARGIN - width, y: MARGIN - 18, size: 8, font: fonts.sans, color: GREY });
  });

  return doc.save();
}

/** Builds the PDF and hands it to the browser as a download. */
export async function downloadResume(): Promise<void> {
  const bytes = await buildResume();
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = resume.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
