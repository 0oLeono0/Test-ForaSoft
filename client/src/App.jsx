// Маршруты SPA (TDD §4.1.1). Router создаётся в main.jsx, в тестах — MemoryRouter.
import { Navigate, Route, Routes } from 'react-router-dom';
import HomePage from './pages/HomePage.jsx';
import RoomPage from './pages/RoomPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/room/:roomId" element={<RoomPage />} />
      {/* Любой другой адрес — на главную; истории браузера лишняя запись не нужна. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
