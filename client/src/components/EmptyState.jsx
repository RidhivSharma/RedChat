/**
 * Reusable empty state for lists and panels.
 *
 * <EmptyState icon={<ChatBubbleIcon size={28} />} title="No conversations yet"
 *   description="They will appear here." action={<button ... />} />
 */
export default function EmptyState({ icon, title, description, action }) {
  return (
    <div className="empty-state">
      {icon ? (
        <div className="empty-state__icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <h2 className="empty-state__title">{title}</h2>
      {description ? <p className="empty-state__description">{description}</p> : null}
      {action ?? null}
    </div>
  );
}
