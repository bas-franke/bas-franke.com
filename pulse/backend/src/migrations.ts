/** Schema migrations, applied in order at startup (see db.ts). Never edit an applied migration; add a new one. */
export const migrations: { name: string; sql: string }[] = [
  {
    name: '001_tasks_and_notes',
    sql: `
      CREATE TABLE tasks (
        id          uuid PRIMARY KEY,
        title       text NOT NULL DEFAULT '',
        details     text NOT NULL DEFAULT '',
        status      text NOT NULL DEFAULT 'todo',
        due         date,
        position    double precision NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX tasks_status_position ON tasks (status, position);

      CREATE TABLE notes (
        id          uuid PRIMARY KEY,
        title       text NOT NULL DEFAULT '',
        body        text NOT NULL DEFAULT '',
        cover       text NOT NULL DEFAULT '',
        pinned      boolean NOT NULL DEFAULT false,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX notes_updated ON notes (updated_at DESC);
    `,
  },
];
