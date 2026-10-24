import { useEffect, useState } from 'react';

type ApiState = 'checking' | 'online' | 'offline';

export default function App() {
  const [api, setApi] = useState<ApiState>('checking');

  useEffect(() => {
    fetch('/api/health')
      .then((res) => setApi(res.ok ? 'online' : 'offline'))
      .catch(() => setApi('offline'));
  }, []);

  return (
    <main className="page">
      <header className="hero">
        <p className="eyebrow">Portfolio</p>
        <h1>Bas Franke</h1>
        <p className="lead">Software developer. This site is under construction; projects and more are coming soon.</p>
      </header>

      <section className="section">
        <h2>Projects</h2>
        <p className="muted">Coming soon.</p>
      </section>

      <footer className="footer">
        <span>© {new Date().getFullYear()} Bas Franke</span>
        <span className={`api api-${api}`} title="Backend status">
          API {api}
        </span>
      </footer>
    </main>
  );
}
