// The Dustrunners courses the room can pick from, by id. The courses themselves (centreline, theme, set pieces) are
// in frontend/src/racer/core/tracks.ts TRACKS; this list must name the same ids, and the pods the same as PODS there.

export const DR_TRACKS: { id: string; name: string }[] = [
  { id: 'redrock', name: 'Redrock Run' },
];

export const drTrackById = (id: string) => DR_TRACKS.find((t) => t.id === id);

export const DR_PODS = ['ember', 'viper', 'gilded', 'tide', 'crimson'] as const;
