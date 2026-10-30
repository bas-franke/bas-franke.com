/** The hours behind the page and the sun marking them; daylight.css ties both to the scroll. */
export default function Day() {
  return (
    <>
      <div className="day" aria-hidden="true">
        <div className="day__light day__light--dawn" />
        <div className="day__light day__light--noon" />
        <div className="day__light day__light--afternoon" />
        <div className="day__light day__light--dusk" />
      </div>
      <div className="sunpath" aria-hidden="true">
        <svg className="sunpath__arc" viewBox="0 0 100 16" preserveAspectRatio="none">
          <path d="M0 12 Q50 -4 100 12" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="sunpath__x">
          <div className="sunpath__y">
            <div className="sunpath__sun" />
            <div className="sunpath__moon" />
          </div>
        </div>
      </div>
    </>
  );
}
