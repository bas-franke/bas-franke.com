// Dev only: the room page for one Last Light room, without the rest of the site (so a broken module elsewhere,
// e.g. the racer mid-edit, cannot block testing the game). Open /lab-zombies-room.html?code=ABCD.
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RoomPage } from '../../room/Room';
import '../../styles.css';

const code = new URLSearchParams(location.search).get('code') ?? '';

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[`/room/${code}`]}>
    <Routes>
      <Route path="/room/:code" element={<RoomPage />} />
      <Route path="*" element={<p style={{ color: '#fff' }}>Left the room.</p>} />
    </Routes>
  </MemoryRouter>,
);
