ALTER TABLE "Message"
  ADD COLUMN "playbackSessionId" TEXT,
  ADD COLUMN "isSpoiler" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "autoReveal" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "CinemaMoment" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "videoUrl" TEXT NOT NULL,
  "videoTime" INTEGER NOT NULL,
  "playbackSessionId" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CinemaMoment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CinemaMoment_userId_requestId_key" ON "CinemaMoment"("userId", "requestId");
CREATE UNIQUE INDEX "CinemaMoment_roomId_userId_playbackSessionId_videoTime_key" ON "CinemaMoment"("roomId", "userId", "playbackSessionId", "videoTime");
CREATE INDEX "CinemaMoment_roomId_createdAt_idx" ON "CinemaMoment"("roomId", "createdAt");

ALTER TABLE "CinemaMoment" ADD CONSTRAINT "CinemaMoment_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CinemaMoment" ADD CONSTRAINT "CinemaMoment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
