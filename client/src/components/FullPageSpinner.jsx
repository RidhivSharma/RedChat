export default function FullPageSpinner({ label = 'Loading…' }) {
  return (
    <div className="full-page-center" role="status" aria-live="polite">
      <span className="spinner spinner--lg" aria-hidden="true" />
      <span className="full-page-center__label">{label}</span>
    </div>
  );
}
