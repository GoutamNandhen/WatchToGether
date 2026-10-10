-- An explicitly ended room must stay closed; isActive also becomes false when a room is merely idle.
ALTER TABLE "Room" ADD COLUMN "endedAt" TIMESTAMP(3);
