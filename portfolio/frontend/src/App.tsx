import Day from './components/Day';
import Nav from './components/Nav';
import Hero from './components/Hero';
import About from './components/About';
import Work from './components/Work';
import Skills from './components/Skills';
import Contact from './components/Contact';
import Footer from './components/Footer';
import InterludeBand from './components/InterludeBand';
import InterludeSplit from './components/InterludeSplit';
import InterludeArch from './components/InterludeArch';
import { interludes, nav } from './content';
import { ThemeProvider } from './hooks/useTheme';
import { useRevealAll } from './hooks/useReveal';

export default function App() {
  useRevealAll();
  return (
    <ThemeProvider>
      <a className="skip" href="#top">
        {nav.skip}
      </a>
      <Day />
      <Nav />
      <main id="top">
        <Hero />
        <About />
        <InterludeBand name="morning" {...interludes.morning} />
        <Work />
        <InterludeSplit name="evening" nightPainting {...interludes.evening} />
        <Skills />
        <InterludeArch name="fireside" nightPainting {...interludes.fireside} />
        <Contact />
      </main>
      <Footer />
    </ThemeProvider>
  );
}
