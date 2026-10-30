import { useEffect, useState } from 'react';
import { watchScroll } from './watchScroll';

/** Pixels of scroll before the bar needs a ground of its own to stay readable. */
const SCROLLED = 12;

/** The night reaches the bar while the first night part of the page is still this far down the screen, on the sunset. */
const NIGHTFALL = 0.25;

/** What the nav bar stands on: whether the page has moved under it, and whether that page has turned to night. */
export function useNavScroll() {
  const [scrolled, setScrolled] = useState(false);
  const [night, setNight] = useState(false);

  useEffect(() => {
    const dusk = document.querySelector('.interlude__stage, #contact');
    return watchScroll(() => {
      setScrolled(window.scrollY > SCROLLED);
      setNight(dusk !== null && dusk.getBoundingClientRect().top < window.innerHeight * NIGHTFALL);
    });
  }, []);

  return { scrolled, night };
}
