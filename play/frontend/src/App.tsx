import { Navigate, Route, Routes } from 'react-router-dom';
import { Lobby } from './lobby/Lobby';
import { RacerLab, RacerPage } from './racer/RacerPage';
import { RoomPage } from './room/Room';
import { FullscreenPrompt } from './ui/FullscreenPrompt';

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Lobby />} />
        <Route path="/room/:code" element={<RoomPage />} />
        <Route path="/race" element={<RacerPage />} />
        <Route path="/race/lab/:name" element={<RacerLab />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <FullscreenPrompt />
    </>
  );
}
