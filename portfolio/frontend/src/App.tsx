import Nav from './components/Nav';
import Hero from './components/Hero';
import About from './components/About';
import Work from './components/Work';
import Skills from './components/Skills';
import Contact from './components/Contact';
import Footer from './components/Footer';
import Interlude from './components/Interlude';
import { interludes } from './content';
import { ThemeProvider } from './hooks/useTheme';
import { useRevealAll } from './hooks/useReveal';

function Page() {
  useRevealAll();
  return (
    <>
      <a className="skip" href="#about">
        Skip to content
      </a>
      <Nav />
      <main id="top">
        <Hero />
        <About />
        <Interlude name="morning" {...interludes.morning} />
        <Work />
        <Interlude name="evening" {...interludes.evening} />
        <Skills />
        <Interlude name="fireside" {...interludes.fireside} />
        <Contact />
      </main>
      <Footer />
    </>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <Page />
    </ThemeProvider>
  );
}
