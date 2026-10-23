/** The wait while a page's code arrives: a small blob in the amoeba's colours.
 *  CSS only (src/core.css); it fades in after a beat so quick loads never show it. */
export default function Loader() {
  return (
    <div className="mdc-loader" role="status" aria-label="Loading">
      <div className="mdc-blob" />
    </div>
  );
}
