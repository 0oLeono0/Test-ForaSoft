import { useParams } from 'react-router-dom';
import RoomLayout from '../components/RoomLayout.jsx';

/**
 * Экран комнаты (TDD §4.1.1). Конечный автомат входа, сетка, чат и список участников
 * появляются в задачах 6.4–7.3; пока это только раскладка.
 */
export default function RoomPage() {
  const { roomId } = useParams();

  return (
    <RoomLayout sidebar={<p>Участники и чат</p>}>
      <h1>Комната {roomId}</h1>
    </RoomLayout>
  );
}
