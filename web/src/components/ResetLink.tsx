import { useState } from 'react';
import { useApp } from '../state';
import { ActionError, Confirm } from './ui';

/** Asks before resetting the group's link, then resets it. Used from the trip's menu and from Members. */
export function ResetLinkConfirm(props: { onDone(message: string): void; onCancel(): void }) {
  const { client, setGroup } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  async function reset(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const result = await client.resetLink();
      client.setLaunch(result.launch);
      setGroup((current) => ({ ...current, group: result.group, link: result.link }));
      props.onDone('The link was reset. A new pinned message is posted in the group.');
    } catch (problem) {
      setError(problem);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Confirm title="Reset the group's link?" confirmLabel="Reset link" danger busy={busy} onCancel={props.onCancel} onConfirm={() => void reset()}>
      <ActionError error={error} />
      <p>Old links stop working for everyone, including buttons on older messages in the chat. A new message with the new link is posted and pinned in the group.</p>
      <p>People who already joined stay members.</p>
    </Confirm>
  );
}
