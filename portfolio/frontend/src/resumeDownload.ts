import photoUrl from './art/profile.jpg';
import { experience, resume } from './content';
import { buildResume, type ResumeAssets } from './resume';

/**
 * The browser side of the résumé: fetches the artwork Vite bundled, builds the PDF and hands it
 * to the browser as a download. Loaded on demand by ResumeButton, so pdf-lib stays out of the
 * main bundle.
 */

const logoUrls = import.meta.glob<string>('./art/logos/*.png', { eager: true, import: 'default' });

async function bytes(url: string | undefined): Promise<Uint8Array | undefined> {
  if (!url) return undefined;
  try {
    const res = await fetch(url);
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : undefined;
  } catch {
    return undefined; // a missing image only costs its slot in the PDF
  }
}

export async function downloadResume(): Promise<void> {
  const logos: ResumeAssets['logos'] = {};
  await Promise.all(
    experience.map(async (job) => {
      logos[job.slug] = await bytes(logoUrls[`./art/logos/${job.slug}.png`]);
    }),
  );
  const photo = await bytes(photoUrl);

  const pdf = await buildResume({ photo, logos });
  const blob = new Blob([pdf as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = resume.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
