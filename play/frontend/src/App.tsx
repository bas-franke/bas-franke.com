import { Navigate, Route, Routes } from 'react-router-dom';
import { Lobby } from './lobby/Lobby';
import { RoomPage } from './room/Room';
import { FullscreenPrompt } from './ui/FullscreenPrompt';

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Lobby />} />
        <Route path="/room/:code" element={<RoomPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <FullscreenPrompt />
    </>
  );
}
