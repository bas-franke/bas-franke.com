import { artUrl } from '../components/Art';
import { useTheme } from './useTheme';

/**
 * The picture of an interlude for the current theme. In dark mode a `-dark` file is used when it
 * exists; a painting that already shows the evening (`nightPainting`) is fine as it is. Anything
 * else gives nothing: filtering a day painting never makes it night.
 */
export function useInterludeArt(name: string, nightPainting = false): string | undefined {
  const { theme } = useTheme();
  const file = `interlude-${name}`;
  if (theme === 'light') return artUrl(file);
  return artUrl(`${file}-dark`) ?? (nightPainting ? artUrl(file) : undefined);
}
