/**
 * The one placeholder used everywhere a list is empty or the page is
 * unreachable. Centralised so "nothing here" never looks like a rendering bug.
 */

import type { ReactNode } from 'react';

export interface EmptyStateProps {
  /** optional icon element, usually one of the `Icons` at size 22 */
  icon?: ReactNode;
  title: string;
  hint?: string;
  /** optional call to action rendered under the hint */
  action?: ReactNode;
}

/** A bordered, centred "nothing to show" block. */
export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="empty">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <div className="empty-title">{title}</div>
      {hint ? <div className="empty-hint">{hint}</div> : null}
      {action}
    </div>
  );
}
