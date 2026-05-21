import {
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  Volume2Icon,
  VideoIcon,
  VideoOffIcon,
  ScreenShareIcon,
  ScreenShareOffIcon,
  HeadphonesIcon,
  HeadphoneOffIcon,
} from "lucide-react"
import { motion } from "framer-motion"

import { Button } from "@/components/ui/button.tsx"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface VoicePipProps {
  channelName: string
  serverName: string
  isMuted: boolean
  isDeafened: boolean
  isVideoOn: boolean
  isScreenSharing: boolean
  onToggleMute: () => void
  onToggleDeafen: () => void
  onToggleVideo: () => void
  onToggleScreen: () => void
  onDisconnect: () => void
  onJump: () => void
}

export function VoicePip({
  channelName,
  serverName,
  isMuted,
  isDeafened,
  isVideoOn,
  isScreenSharing,
  onToggleMute,
  onToggleDeafen,
  onToggleVideo,
  onToggleScreen,
  onDisconnect,
  onJump,
}: VoicePipProps) {
  return (
    <motion.div
      key="voice-pip"
      initial={{ opacity: 0, height: 0, marginBottom: 0 }}
      animate={{ opacity: 1, height: "auto", marginBottom: 6 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 28 }}
      className="overflow-hidden"
    >
      <Card
        role="region"
        aria-label="Voice connection"
        data-slot="bottom-dock-panel"
        className="gap-0 rounded-lg border-transparent py-0 shadow-none ring-0"
      >
        <div className="flex items-center gap-2 px-2 pt-2 pb-1">
          <button
            type="button"
            onClick={onJump}
            className="flex min-w-0 flex-1 items-center gap-2 pl-1 text-left focus-visible:outline-none"
            aria-label="Jump to voice channel"
          >
            <Volume2Icon className="size-4 shrink-0 text-success" />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-xs font-medium text-success">
                Voice connected
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {channelName} · {serverName}
              </span>
            </span>
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="!size-8 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onDisconnect}
            aria-label="Disconnect"
          >
            <PhoneOffIcon />
          </Button>
        </div>
        <div className="grid grid-cols-4 gap-2 px-2 pt-0 pb-2">
          <Button
            variant={isMuted ? "destructive" : "secondary"}
            size="icon"
            className={cn(
              "h-8 !w-full",
              !isMuted && "hover:bg-foreground/10 hover:text-foreground"
            )}
            onClick={onToggleMute}
            aria-label={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted ? <MicOffIcon /> : <MicIcon />}
          </Button>
          <Button
            variant={isDeafened ? "destructive" : "secondary"}
            size="icon"
            className={cn(
              "h-8 !w-full",
              !isDeafened && "hover:bg-foreground/10 hover:text-foreground"
            )}
            onClick={onToggleDeafen}
            aria-label={isDeafened ? "Undeafen" : "Deafen"}
          >
            {isDeafened ? <HeadphoneOffIcon /> : <HeadphonesIcon />}
          </Button>
          <Button
            variant={isVideoOn ? "default" : "secondary"}
            size="icon"
            className={cn(
              "h-8 !w-full",
              !isVideoOn
                ? "hover:bg-foreground/10 hover:text-foreground"
                : "hover:bg-foreground/80"
            )}
            onClick={onToggleVideo}
            aria-label={isVideoOn ? "Stop video" : "Start video"}
          >
            {isVideoOn ? <VideoIcon /> : <VideoOffIcon />}
          </Button>
          <Button
            variant={isScreenSharing ? "default" : "secondary"}
            size="icon"
            className={cn(
              "h-8 !w-full",
              !isScreenSharing
                ? "hover:bg-foreground/10 hover:text-foreground"
                : "hover:bg-foreground/80"
            )}
            onClick={onToggleScreen}
            aria-label={
              isScreenSharing ? "Stop sharing screen" : "Share screen"
            }
          >
            {isScreenSharing ? <ScreenShareOffIcon /> : <ScreenShareIcon />}
          </Button>
        </div>
      </Card>
    </motion.div>
  )
}
