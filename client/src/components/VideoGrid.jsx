import { gridLayout } from '../utils/gridLayout.js';
import VideoTile from './VideoTile.jsx';
import './VideoGrid.css';

/**
 * @typedef {Object} Tile
 * @property {string}  id
 * @property {string}  name
 * @property {MediaStream|null} [stream]
 * @property {boolean} audio
 * @property {boolean} video
 * @property {boolean} [isSelf]
 * @property {string|null} [linkStatus]
 */

/**
 * Адаптивная сетка на 1–4 плитки (FR-11, US-6). Своя плитка всегда первая (TDD §4.1.5, Q-1),
 * порядок остальных — порядок входа.
 * @param {Object} props
 * @param {Tile[]} props.tiles
 * @param {() => void} [props.onAutoplayBlocked]
 */
export default function VideoGrid({ tiles, onAutoplayBlocked }) {
  const { columns, rows } = gridLayout(tiles.length);
  // Сортировка устойчива: среди остальных участников порядок входа сохраняется.
  const ordered = [...tiles].sort((a, b) => Number(b.isSelf ?? false) - Number(a.isSelf ?? false));

  return (
    <div
      className="video-grid"
      style={{ '--grid-columns': columns, '--grid-rows': rows }}
      data-columns={columns}
      data-rows={rows}
    >
      {ordered.map((tile) => (
        <VideoTile
          key={tile.id}
          name={tile.name}
          stream={tile.stream ?? null}
          audio={tile.audio}
          video={tile.video}
          isSelf={tile.isSelf ?? false}
          linkStatus={tile.linkStatus ?? null}
          onAutoplayBlocked={onAutoplayBlocked}
        />
      ))}
    </div>
  );
}
