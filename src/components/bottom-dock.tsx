import { Card } from "@/components/ui/card"
import { GlobalBugReportButton } from "@/components/global-bug-report-button"
import { UserMenu, type UserMenuUser } from "@/components/user-menu"
import { VoicePip } from "@/components/voice-pip"
import { AnimatePresence } from "framer-motion"

interface BottomDockProps {
  user: UserMenuUser
  onOpenUserSettings?: () => void
  onSignOut?: () => void | Promise<void>
  voice?: {
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
}

export function BottomDock({
  user,
  onOpenUserSettings,
  onSignOut,
  voice,
}: BottomDockProps) {
  return (
    <div className="flex w-full flex-col gap-1">
      <AnimatePresence initial={false}>
        {voice ? <VoicePip key="voice-pip" {...voice} /> : null}
      </AnimatePresence>
      <Card
        data-slot="bottom-dock-panel"
        className="gap-0 rounded-lg border-transparent py-0 shadow-none ring-0"
      >
        <UserMenu
          user={user}
          onOpenSettings={onOpenUserSettings}
          onSignOut={onSignOut}
          utilityAction={
            <GlobalBugReportButton className="size-9 shrink-0 text-muted-foreground hover:text-foreground" />
          }
        />
      </Card>
    </div>
  )
}
