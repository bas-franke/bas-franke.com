import { useEffect, useState } from 'react';
import { footer, site } from '../content';

type ApiState = 'checking' | 'online' | 'offline';

export default function Footer() {
  const [api, setApi] = useState<ApiState>('checking');

  useEffect(() => {
    fetch('/api/health')
      .then((res) => setApi(res.ok ? 'online' : 'offline'))
      .catch(() => setApi('offline'));
  }, []);

  return (
    <footer className="footer container">
      <div className="footer__row">
        <span>
          © {new Date().getFullYear()} {site.name}
        </span>
        <span className="footer__note">{footer.note}</span>
        <span className="footer__right">
          <span className={`api api--${api}`} title="Backend status">
            API {api}
          </span>
          <a href="#top" className="footer__top">
            Top ↑
          </a>
        </span>
      </div>
    </footer>
  );
}
