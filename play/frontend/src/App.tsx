import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Lobby } from './lobby/Lobby';
import { RacerLab, RacerPage } from './racer/RacerPage';
import { RoomPage } from './room/Room';
import { FullscreenPrompt } from './ui/FullscreenPrompt';

/** Last Light's title screen is a page of its own; only visitors who open it download it. */
const LastLightMenu = lazy(() => import('./games/zombies/menu/LastLightMenu').then((m) => ({ default: m.LastLightMenu })));

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Lobby />} />
        <Route path="/room/:code" element={<RoomPage />} />
        <Route path="/race" element={<RacerPage />} />
        <Route path="/race/lab/:name" element={<RacerLab />} />
        <Route
          path="/lastlight"
          element={
            <Suspense fallback={<div style={{ position: 'fixed', inset: 0, background: '#0a0807' }} />}>
              <LastLightMenu />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <FullscreenPrompt />
    </>
  );
}
