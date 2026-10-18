/**
 * Label + control + inline error/hint, wired for accessibility:
 * the error paragraph gets id `${id}-error` so the input can point at it with
 * aria-describedby.
 */
export default function FormField({ id, label, error, hint, children }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="field__error" id={`${id}-error`}>
          {error}
        </p>
      ) : hint ? (
        <p className="field__hint">{hint}</p>
      ) : null}
    </div>
  );
}
