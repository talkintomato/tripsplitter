import { Sheet } from '../components/ui';

/** Common ones for a trip. Any other emoji can be typed at the start of the title. */
export const EMOJIS = ['🍜', '🍣', '🍕', '🍔', '🥗', '☕', '🍺', '🍷', '🍸', '🛒', '🚕', '🚆', '✈️', '⛽', '🅿️', '🏨', '🏠', '🎟️', '🎢', '🏛️', '♨️', '🎁', '💊', '👕'];

/** A sheet of emojis for the title of an expense. The chosen one becomes the expense's tile. */
export function EmojiPicker(props: { current: string | null; onPick(emoji: string | null): void; onClose(): void }) {
  return (
    <Sheet label="Choose an emoji" onClose={props.onClose}>
      <h2 className="sheet-title">Choose an emoji</h2>
      <div className="emoji-grid" role="group" aria-label="Emojis">
        {EMOJIS.map((emoji) => (
          <button key={emoji} type="button" className={`emoji-choice ${props.current === emoji ? 'on' : ''}`} aria-pressed={props.current === emoji} aria-label={emoji} onClick={() => { props.onPick(emoji); props.onClose(); }}>
            {emoji}
          </button>
        ))}
      </div>
      <p className="field-hint">It is shown as the expense's picture in the list. Without one, a picture is picked from the title.</p>
      <div className="sheet-actions">
        {props.current ? (
          <button type="button" className="btn btn-secondary btn-block" onClick={() => { props.onPick(null); props.onClose(); }}>
            No emoji
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost btn-block" onClick={props.onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}
