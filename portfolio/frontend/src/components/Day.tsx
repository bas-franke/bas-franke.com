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
        <div className="sunpath__track">
          <div className="sunpath__sun" />
          <div className="sunpath__moon" />
        </div>
      </div>
    </>
  );
}
