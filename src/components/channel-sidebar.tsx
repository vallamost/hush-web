import * as React from "react"
import { createPortal } from "react-dom"
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronsUpDownIcon,
  GripVerticalIcon,
  HashIcon,
  HeadphoneOffIcon,
  InfoIcon,
  MicOffIcon,
  Volume2Icon,
  PlusIcon,
  FolderPlusIcon,
  CompassIcon,
  ScrollTextIcon,
  ShieldAlertIcon,
  LogOutIcon,
  PuzzleIcon,
  SettingsIcon,
  TrashIcon,
} from "lucide-react"
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.tsx"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button.tsx"
import { HushLogo } from "@/components/brand/HushLogo"
import { BottomDock } from "@/components/bottom-dock"
import type { UserMenuUser } from "@/components/user-menu"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useSidebar } from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip.tsx"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx"
import { APP_VERSION } from "@/utils/constants"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

type ChannelKind = "text" | "voice"
/** Kinds that the create-from-context-menu flow can produce. Categories are
 *  not first-class `Channel` rows (they live in `ChannelCategory`), but the
 *  backend mints them through the same `createGuildChannel` endpoint with
 *  `type: "category"`. The shell maps the response back into the right list. */
type CreateChannelKind = "text" | "voice" | "category"

type VoiceParticipant = {
  id: string
  name: string
  initials: string
  isMuted?: boolean
  isDeafened?: boolean
  isSpeaking?: boolean
}

type Channel = {
  id: string
  name: string
  kind: ChannelKind
  categoryId: string | null
  unreadCount?: number
  mentionCount?: number
  participants?: VoiceParticipant[]
}

type ChannelCategory = {
  id: string
  name: string
}

const ROOT_DROPPABLE_ID = "__root__"

type SystemChannel = {
  id: string
  name: string
  icon: React.ReactNode
}

type AppEntry = {
  id: string
  name: string
  icon: React.ReactNode
}

interface RailEntry {
  id: string
  name: string
  initials: string
}

type DirectMessage = {
  id: string
  name: string
  initials: string
  presence?: "online" | "idle" | "dnd" | "offline"
}

interface JoinedVoiceInfo {
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

interface ChannelSidebarProps {
  serverName: string
  serverPlan?: string
  systemChannels: SystemChannel[]
  categories: ChannelCategory[]
  channels: Channel[]
  apps?: AppEntry[]
  directMessages?: DirectMessage[]
  activeChannelId: string
  onSelectChannel: (id: string) => void
  onCategoriesChange?: (next: ChannelCategory[]) => void
  onChannelsChange?: (next: Channel[]) => void
  user: UserMenuUser
  railEntries: RailEntry[]
  activeRailId: string
  onSelectRail: (id: string) => void
  voice?: JoinedVoiceInfo
  onOpenServerSettings?: () => void
  onOpenUserSettings?: () => void
  onSignOut?: () => void | Promise<void>
  /** Create a new channel of the given kind. Resolves on success. */
  onCreateChannel?: (
    kind: CreateChannelKind,
    name: string,
    parentId?: string | null
  ) => Promise<void>
  /** Delete a channel. Confirmation handled by caller via wrapper if needed. */
  onDeleteChannel?: (channelId: string) => Promise<void>
  /** Delete a category. Same backend as channel delete (categories are
   *  channels of `type: "category"` upstream); the sidebar surfaces a
   *  confirmation dialog because the action cascades to nested
   *  channels server-side. */
  onDeleteCategory?: (categoryId: string) => Promise<void>
  /** Create an invite for the active server. Returns the shareable URL. */
  onCreateInvite?: () => Promise<string | null>
  /** Whether the current user can perform admin actions (create/delete channel, invite). */
  canAdministrate?: boolean
  /** Home/DM surfaces reuse this shell but must not expose server actions. */
  serverMenuEnabled?: boolean
  /** Open the create-server dialog (mobile rail dropdown surfaces this since
   *  the desktop bottom rail with [+]/Discover icons is not visible). */
  onCreateServer?: () => void
  /** Navigate to the discover-servers route. */
  onDiscoverServers?: () => void
}

const CHANNELS_SECTION_LABEL = "Channels"

/**
 * Two-line version readout for the About dialog.
 *
 * Renders `<v.x.y.z> hush-web` on the first line and, when running inside
 * the Electron renderer, `<v.x.y.z> hush-desktop` on the second line in
 * identical typography. Browser builds show only the web line.
 */
interface DesktopBridge {
  isDesktop?: boolean
  getAppVersion?: () => Promise<string>
}

function AppVersionLines() {
  const [desktopVersion, setDesktopVersion] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const api = (window as unknown as { hushDesktop?: DesktopBridge }).hushDesktop
    if (!api || api.isDesktop !== true) return
    if (typeof api.getAppVersion !== "function") return
    let cancelled = false
    api.getAppVersion()
      .then((value: string) => {
        if (cancelled) return
        if (typeof value === "string" && value.length > 0) setDesktopVersion(value)
      })
      .catch(() => {
        // Best-effort: a missing version simply hides the desktop line.
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex flex-col items-center gap-0.5 font-mono text-[10px] text-muted-foreground/70">
      <span>
        v{APP_VERSION} <span className="text-muted-foreground/50">hush-web</span>
      </span>
      {desktopVersion && (
        <span>
          v{desktopVersion} <span className="text-muted-foreground/50">hush-desktop</span>
        </span>
      )}
    </div>
  )
}

export function ChannelSidebar({
  serverName,
  serverPlan,
  systemChannels,
  categories,
  channels,
  // apps prop reserved for a future integrations row; rendering is gated
  // on backend support and currently disabled.
  apps: _apps,
  directMessages,
  activeChannelId,
  onSelectChannel,
  onCategoriesChange,
  onChannelsChange,
  user,
  railEntries,
  activeRailId,
  onSelectRail,
  voice,
  onOpenServerSettings,
  onOpenUserSettings,
  onSignOut,
  onCreateChannel,
  onDeleteChannel,
  onDeleteCategory,
  onCreateInvite,
  canAdministrate = false,
  serverMenuEnabled = true,
  onCreateServer,
  onDiscoverServers,
}: ChannelSidebarProps) {
  const { isMobile, openMobile, setOpenMobile } = useSidebar()

  // Mobile: closing the sheet on channel pick removes a manual close
  // step the user would otherwise hit on every navigation. The sheet
  // animation does not race the channel-view mount because the new
  // channel renders behind the sheet, not as a sibling overlay.
  const handleSelectChannelMobile = React.useCallback(
    (id: string) => {
      onSelectChannel(id)
      if (isMobile) {
        setOpenMobile(false)
      }
    },
    [onSelectChannel, isMobile, setOpenMobile]
  )

  const inner = (
    <>
      <div
        data-slot="channel-card"
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-transparent bg-card shadow-none"
      >
        <SidebarHeader>
          <ServerHeader
            name={serverName}
            plan={serverPlan}
            railEntries={railEntries}
            activeRailId={activeRailId}
            onSelectRail={onSelectRail}
            onOpenServerSettings={onOpenServerSettings}
            onCreateInvite={onCreateInvite}
            canAdministrate={canAdministrate}
            menuEnabled={serverMenuEnabled}
            onCreateServer={onCreateServer}
            onDiscoverServers={onDiscoverServers}
          />
        </SidebarHeader>
        <SidebarContent className="show-native-scrollbar">
          {systemChannels.length > 0 ? (
            <SystemSection
              channels={systemChannels}
              activeChannelId={activeChannelId}
              onSelect={handleSelectChannelMobile}
            />
          ) : null}
          {directMessages && directMessages.length > 0 ? (
            <DirectMessagesSection
              entries={directMessages}
              activeChannelId={activeChannelId}
              onSelect={handleSelectChannelMobile}
            />
          ) : null}
          {/* Render ChannelsSection only when this sidebar belongs to a
              real server (serverMenuEnabled=true). The Home sidebar has
              no channel surface, its content is the DM peer list above
             , so the empty "Channels" group reads as a stray heading.
              On server views the section always renders so right-click
              creation + orphan-channel recovery still work even when
              both lists are empty. */}
          {serverMenuEnabled ? (
            <ChannelsSection
              categories={categories}
              channels={channels}
              activeChannelId={activeChannelId}
              onSelect={handleSelectChannelMobile}
              onCategoriesChange={onCategoriesChange}
              onChannelsChange={onChannelsChange}
              onCreateChannel={onCreateChannel}
              onDeleteChannel={onDeleteChannel}
              onDeleteCategory={onDeleteCategory}
              canAdministrate={canAdministrate}
            />
          ) : null}
          {/* maybe for future: {apps.length > 0 ? <AppsSection apps={apps} /> : null} */}
        </SidebarContent>
      </div>
      <BottomDock
        user={user}
        voice={voice}
        onOpenUserSettings={onOpenUserSettings}
        onSignOut={onSignOut}
      />
    </>
  )

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          side="left"
          data-slot="sidebar"
          className="flex w-72 flex-col gap-2 bg-sidebar p-2 [&>button]:hidden"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Sidebar</SheetTitle>
            <SheetDescription>Channels and direct messages.</SheetDescription>
          </SheetHeader>
          {inner}
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <aside
      data-slot="channel-sidebar"
      className="hidden h-full min-h-0 w-full flex-col gap-2 p-2 md:flex"
    >
      {inner}
    </aside>
  )
}

function ServerHeader({
  name,
  plan,
  railEntries,
  activeRailId,
  onSelectRail,
  onOpenServerSettings,
  onCreateInvite,
  canAdministrate,
  menuEnabled,
  onCreateServer,
  onDiscoverServers,
}: {
  name: string
  plan?: string
  railEntries: RailEntry[]
  activeRailId: string
  onSelectRail: (id: string) => void
  onOpenServerSettings?: () => void
  onCreateInvite?: () => Promise<string | null>
  canAdministrate?: boolean
  menuEnabled?: boolean
  onCreateServer?: () => void
  onDiscoverServers?: () => void
}) {
  const [leaveOpen, setLeaveOpen] = React.useState(false)
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [inviteUrl, setInviteUrl] = React.useState<string | null>(null)
  const [inviteError, setInviteError] = React.useState<string | null>(null)
  const [inviteBusy, setInviteBusy] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  // The Home view (menuEnabled=false) replaces the empty server-actions
  // dropdown with an Early Bird greeting + Info entry that opens a
  // centered modal with the project links. State lives here so the
  // Dialog renders alongside the existing Leave / Invite dialogs.
  const [infoOpen, setInfoOpen] = React.useState(false)

  const handleInvite = React.useCallback(async () => {
    if (!onCreateInvite) return
    setInviteBusy(true)
    setInviteError(null)
    setInviteUrl(null)
    setCopied(false)
    setInviteOpen(true)
    try {
      const url = await onCreateInvite()
      setInviteUrl(url ?? null)
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Failed to create invite")
    } finally {
      setInviteBusy(false)
    }
  }, [onCreateInvite])

  const handleCopy = React.useCallback(() => {
    if (!inviteUrl) return
    void navigator.clipboard?.writeText(inviteUrl)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }, [inviteUrl])

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{name}</span>
                {plan ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {plan}
                  </span>
                ) : null}
              </div>
              <ChevronsUpDownIcon className="ml-auto size-4 opacity-70" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
            align="start"
            side="bottom"
            sideOffset={4}
          >
            <div className="md:hidden">
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Servers
              </DropdownMenuLabel>
              {/* Mask gradient (transparent → black at 12px on
                  each edge) was meant to feather long lists, but
                  it always-on dimmed the first + last items even
                  when the list was 1-2 entries and not scrollable,
                  so it read as "sfumato" on Home + the only server.
                  Disabled for now. Restore by re-adding the
                  `[mask-image:linear-gradient(...)]` utility below
                  if we ever wire a scroll-aware variant.
                  Original:
                  [mask-image:linear-gradient(to_bottom,transparent_0,black_12px,black_calc(100%-12px),transparent_100%)] */}
              <div className="max-h-64 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border">
                {railEntries.map((entry) => (
                  <DropdownMenuItem
                    key={entry.id}
                    onSelect={() => onSelectRail(entry.id)}
                    className={cn(
                      entry.id === activeRailId &&
                        "bg-sidebar-accent text-sidebar-accent-foreground"
                    )}
                  >
                    <span className="flex size-5 items-center justify-center rounded-md bg-sidebar-accent text-[10px] font-semibold text-sidebar-accent-foreground">
                      {entry.initials}
                    </span>
                    {entry.name}
                  </DropdownMenuItem>
                ))}
              </div>
              {/* Mobile-only: mirror the desktop rail bottom dock so users
                  on a phone can create or discover servers without a
                  dedicated FAB. Items render at the end of the rail
                  dropdown after the home + server entries. */}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!onCreateServer}
                onSelect={() => onCreateServer?.()}
              >
                <PlusIcon className="size-4" />
                Add server
              </DropdownMenuItem>
              {/* Discover is gated behind the instance-level discovery
                  index, which is not yet shipping. Render disabled+muted
                  to match the command-palette treatment so the
                  affordance reads as "shipping soon" without firing the
                  legacy handler if it's still wired upstream. */}
              <DropdownMenuItem disabled>
                <CompassIcon className="size-4" />
                Discover servers
                <span className="ml-auto text-xs text-muted-foreground">
                  Shipping soon
                </span>
              </DropdownMenuItem>
              {/* Separator between the rail-mirror actions
                  (Add / Discover) and whatever comes next, Server
                  group on a real server, Early Bird + Info section
                  on Home. Render unconditionally so Home gets the
                  same visual break. */}
              <DropdownMenuSeparator />
            </div>
            {menuEnabled ? (
              <>
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Server
                </DropdownMenuLabel>
                <DropdownMenuItem
                  disabled={!onOpenServerSettings}
                  onSelect={() => {
                    // Defer the dialog open so the DropdownMenu can
                    // finish its close + body pointer-events restore
                    // before the Dialog mounts. Stacking two Radix
                    // overlays leaks the body lock on dismiss and
                    // freezes the UI until reload.
                    setTimeout(() => onOpenServerSettings?.(), 0)
                  }}
                >
                  <SettingsIcon className="size-4" />
                  Server settings
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canAdministrate || !onCreateInvite}
                  onSelect={() => {
                    setTimeout(() => void handleInvite(), 0)
                  }}
                >
                  <PlusIcon className="size-4" />
                  Invite people
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => {
                    setTimeout(() => setLeaveOpen(true), 0)
                  }}
                >
                  <LogOutIcon className="size-4" />
                  Leave server
                </DropdownMenuItem>
              </>
            ) : (
              <>
                {/* Home view: replace the empty server-actions block
                    with an Early Bird greeting + a single Info entry
                    that surfaces project links in a centered modal.
                    Otherwise the Home title rendered an empty
                    dropdown on desktop because every section was
                    md:hidden + menuEnabled-gated. */}
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Hey, Early Bird! Thank you for using Hush.
                </DropdownMenuLabel>
                <DropdownMenuItem
                  onSelect={() => {
                    setTimeout(() => setInfoOpen(true), 0)
                  }}
                >
                  <InfoIcon className="size-4" />
                  Info
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader className="sr-only">
            <DialogTitle>About Hush</DialogTitle>
            <DialogDescription>
              Project links for early-bird users.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-6 py-4">
            <HushLogo className="size-20" />
            <div className="flex items-center gap-3 text-sm font-medium text-foreground">
              <a
                href="https://github.com/hushhq/hush"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
              >
                src
                <ArrowUpRightIcon className="size-3.5" />
              </a>
              <span aria-hidden className="text-muted-foreground">
                ·
              </span>
              <a
                href="https://yarincardillo.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
              >
                whoami
                <ArrowUpRightIcon className="size-3.5" />
              </a>
            </div>
            <AppVersionLines />
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              You will lose access to all channels and conversations in {name}.
              Re-joining requires a new invite.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive">
              Leave server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invite people to {name}</DialogTitle>
            <DialogDescription>
              Share this link to let new members join. Single-use unless server
              policy allows reuse.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            {inviteBusy ? (
              <div className="text-sm text-muted-foreground">
                Generating invite…
              </div>
            ) : inviteError ? (
              <div className="text-sm text-destructive">{inviteError}</div>
            ) : inviteUrl ? (
              <div className="flex items-center gap-2">
                <Input readOnly value={inviteUrl} className="font-mono text-xs" />
                <Button type="button" size="sm" onClick={handleCopy}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setInviteOpen(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarMenu>
  )
}

function SystemSection({
  channels,
  activeChannelId,
  onSelect,
}: {
  channels: SystemChannel[]
  activeChannelId: string
  onSelect: (id: string) => void
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>System</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.5">
          {channels.map((channel) => (
            <SidebarMenuItem key={channel.id}>
              <SidebarMenuButton
                isActive={channel.id === activeChannelId}
                onClick={() => onSelect(channel.id)}
              >
                {channel.icon}
                <span>{channel.name}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function DirectMessagesSection({
  entries,
  activeChannelId,
  onSelect,
}: {
  entries: DirectMessage[]
  activeChannelId: string
  onSelect: (id: string) => void
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Direct messages</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.5">
          {entries.map((entry) => (
            <SidebarMenuItem key={entry.id}>
              <SidebarMenuButton
                isActive={entry.id === activeChannelId}
                onClick={() => onSelect(entry.id)}
              >
                <Avatar className="size-5 rounded-full">
                  <AvatarFallback className="rounded-full text-[10px]">
                    {entry.initials}
                  </AvatarFallback>
                </Avatar>
                <span>{entry.name}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

type DraggedKind = "category" | "channel"

interface ChannelsSectionProps {
  categories: ChannelCategory[]
  channels: Channel[]
  activeChannelId: string
  onSelect: (id: string) => void
  onCategoriesChange?: (next: ChannelCategory[]) => void
  onChannelsChange?: (next: Channel[]) => void
  onCreateChannel?: (
    kind: CreateChannelKind,
    name: string,
    parentId?: string | null
  ) => Promise<void>
  onDeleteChannel?: (channelId: string) => Promise<void>
  onDeleteCategory?: (categoryId: string) => Promise<void>
  canAdministrate?: boolean
}

function ChannelsSection({
  categories,
  channels,
  activeChannelId,
  onSelect,
  onCategoriesChange,
  onChannelsChange,
  onCreateChannel,
  onDeleteChannel,
  onDeleteCategory,
  canAdministrate = false,
}: ChannelsSectionProps) {
  const [createOpen, setCreateOpen] = React.useState<CreateChannelKind | null>(null)
  const [createParentId, setCreateParentId] = React.useState<string | null>(null)
  const [createName, setCreateName] = React.useState("")
  const [createBusy, setCreateBusy] = React.useState(false)
  const [createError, setCreateError] = React.useState<string | null>(null)

  const openCreate = React.useCallback(
    (kind: CreateChannelKind, parentId: string | null = null) => {
      // Defer to the next tick so the ContextMenu's close animation +
      // body pointer-events restore complete before the Dialog mounts.
      // Opening synchronously while ContextMenu is still tearing down
      // stacks two Radix overlays and leaves `<body>` with
      // `pointer-events: none` once both are dismissed, freezing every
      // subsequent click until a full page reload.
      setTimeout(() => {
        setCreateOpen(kind)
        setCreateParentId(parentId)
        setCreateName("")
        setCreateError(null)
      }, 0)
    },
    []
  )

  // Window-level event bus: the command palette dispatches
  // `hush:open-create-channel` with a {kind} detail when the user
  // picks "Create channel" / "Create category". Bridging via event
  // avoids lifting the dialog state into authenticated-app just so
  // the palette can reach it.
  React.useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: CreateChannelKind }>).detail
      const kind = detail?.kind
      if (kind === "text" || kind === "voice" || kind === "category") {
        openCreate(kind)
      }
    }
    window.addEventListener("hush:open-create-channel", handler)
    return () => {
      window.removeEventListener("hush:open-create-channel", handler)
    }
  }, [openCreate])

  const submitCreate = React.useCallback(async () => {
    if (!createOpen || !onCreateChannel) return
    const name = createName.trim()
    if (!name) {
      setCreateError(
        createOpen === "category" ? "Category name required" : "Channel name required"
      )
      return
    }
    setCreateBusy(true)
    setCreateError(null)
    try {
      await onCreateChannel(createOpen, name, createParentId)
      setCreateOpen(null)
      setCreateParentId(null)
    } catch (err) {
      const fallback =
        createOpen === "category" ? "Failed to create category" : "Failed to create channel"
      setCreateError(err instanceof Error ? err.message : fallback)
    } finally {
      setCreateBusy(false)
    }
  }, [createOpen, createName, createParentId, onCreateChannel])
  const [activeDrag, setActiveDrag] = React.useState<{
    id: string
    kind: DraggedKind
  } | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const channelsByCategory = React.useMemo(() => {
    const map = new Map<string | null, Channel[]>()
    map.set(null, [])
    const knownCategoryIds = new Set(categories.map((c) => c.id))
    for (const cat of categories) map.set(cat.id, [])
    for (const ch of channels) {
      // Orphan channels (parentId set but the category isn't visible to us
      //, e.g. backend race, permission filter, or a missing template
      // category) fold into root so they remain reachable. Otherwise they
      // would only show in the command palette and never in the sidebar.
      const key =
        ch.categoryId !== null && !knownCategoryIds.has(ch.categoryId)
          ? null
          : ch.categoryId
      map.get(key)!.push(ch)
    }
    return map
  }, [categories, channels])

  const collisionDetection: CollisionDetection = React.useCallback(
    (args) => {
      const activeKind = args.active.data.current?.kind as DraggedKind | undefined
      if (!activeKind) return closestCorners(args)
      const filtered = args.droppableContainers.filter((container) => {
        const accepts = container.data.current?.accepts as
          | DraggedKind[]
          | undefined
        if (!accepts) return false
        return accepts.includes(activeKind)
      })
      return closestCorners({ ...args, droppableContainers: filtered })
    },
    []
  )

  const handleDragStart = (event: DragStartEvent) => {
    const kind = event.active.data.current?.kind as DraggedKind | undefined
    if (!kind) return
    setActiveDrag({ id: String(event.active.id), kind })
  }

  const handleDragOver = (event: DragOverEvent) => {
    if (!event.over) return
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    setActiveDrag(null)
    if (!over) return
    const activeKind = active.data.current?.kind as DraggedKind | undefined

    if (activeKind === "category") {
      if (active.id === over.id) return
      const oldIndex = categories.findIndex((c) => c.id === active.id)
      const newIndex = categories.findIndex((c) => c.id === over.id)
      if (oldIndex < 0 || newIndex < 0) return
      onCategoriesChange?.(arrayMove(categories, oldIndex, newIndex))
      return
    }

    if (activeKind === "channel") {
      const activeChannel = channels.find((c) => c.id === active.id)
      if (!activeChannel) return

      const overData = over.data.current as
        | { kind?: DraggedKind; categoryId?: string | null }
        | undefined

      let targetCategoryId: string | null
      if (over.id === ROOT_DROPPABLE_ID) {
        targetCategoryId = null
      } else if (overData?.kind === "category") {
        targetCategoryId = String(over.id).startsWith("cat-zone-")
          ? String(over.id).slice("cat-zone-".length)
          : null
      } else if (overData?.kind === "channel") {
        targetCategoryId = (overData.categoryId ?? null) as string | null
      } else {
        return
      }

      const channelsWithoutActive = channels.filter((c) => c.id !== active.id)
      const targetSubset = channelsWithoutActive.filter(
        (c) => c.categoryId === targetCategoryId
      )
      const overChannelId =
        overData?.kind === "channel" ? String(over.id) : null
      const insertIndex = overChannelId
        ? targetSubset.findIndex((c) => c.id === overChannelId)
        : targetSubset.length

      const nextTargetSubset = [...targetSubset]
      nextTargetSubset.splice(Math.max(insertIndex, 0), 0, {
        ...activeChannel,
        categoryId: targetCategoryId,
      })

      const next = [
        ...channelsWithoutActive.filter((c) => c.categoryId !== targetCategoryId),
        ...nextTargetSubset,
      ]
      if (!sameChannelOrder(channels, next)) onChannelsChange?.(next)
    }
  }

  const rootChannels = channelsByCategory.get(null) ?? []
  const draggedChannel =
    activeDrag?.kind === "channel"
      ? channels.find((c) => c.id === activeDrag.id) ?? null
      : null
  const draggedCategory =
    activeDrag?.kind === "category"
      ? categories.find((c) => c.id === activeDrag.id) ?? null
      : null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <ContextMenu>
        <ContextMenuTrigger className="flex flex-1 flex-col">
          <SidebarGroup className="flex-1">
            <SidebarGroupLabel>{CHANNELS_SECTION_LABEL}</SidebarGroupLabel>
            <SidebarGroupContent className="flex flex-col gap-1">
              <RootChannelsZone
                channels={rootChannels}
                activeChannelId={activeChannelId}
                onSelect={onSelect}
                onDeleteChannel={onDeleteChannel}
                canAdministrate={canAdministrate}
              />
              <SortableContext
                items={categories.map((c) => c.id)}
                strategy={verticalListSortingStrategy}
              >
                {categories.map((category) => (
                  <SortableCategory
                    key={category.id}
                    category={category}
                    channels={channelsByCategory.get(category.id) ?? []}
                    activeChannelId={activeChannelId}
                    onSelect={onSelect}
                    onDeleteChannel={onDeleteChannel}
                    onDeleteCategory={onDeleteCategory}
                    canAdministrate={canAdministrate}
                    onCreateTextChannel={
                      canAdministrate && onCreateChannel
                        ? () => openCreate("text", category.id)
                        : undefined
                    }
                  />
                ))}
              </SortableContext>
            </SidebarGroupContent>
          </SidebarGroup>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem
            disabled={!canAdministrate || !onCreateChannel}
            onSelect={() => openCreate("category")}
          >
            <FolderPlusIcon className="size-4" />
            New category
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!canAdministrate || !onCreateChannel}
            onSelect={() => openCreate("text")}
          >
            <HashIcon className="size-4" />
            New text channel
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!canAdministrate || !onCreateChannel}
            onSelect={() => openCreate("voice")}
          >
            <Volume2Icon className="size-4" />
            New voice channel
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {/* Portal the overlay to <body> so its position:fixed resolves against
          the viewport. On desktop the shell content sets transform:
          translateZ(0), which would otherwise make the fixed overlay offset
          from the cursor by the shell/topbar origin. */}
      {createPortal(
      <DragOverlay>
        {draggedChannel ? (
          // Self-contained, fixed-height, opaque preview. Reusing the real
          // SidebarMenuButton here renders it outside the SidebarProvider
          // (DragOverlay portals to <body>), where its context-driven sizing
          // is absent and the row looks oversized. This mirrors the real row
          // metrics (h-8, gap-2, icon size-4) without that dependency.
          <div className="flex h-8 w-full cursor-grabbing items-center gap-2 rounded-md bg-popover px-2 text-sm text-foreground shadow-lg select-none">
            {draggedChannel.kind === "voice" ? (
              <Volume2Icon className="size-4 shrink-0" />
            ) : (
              <HashIcon className="size-4 shrink-0" />
            )}
            <span className="truncate">{draggedChannel.name}</span>
          </div>
        ) : draggedCategory ? (
          <div className="flex h-8 cursor-grabbing items-center rounded-md bg-popover px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground shadow-lg select-none">
            {draggedCategory.name}
          </div>
        ) : null}
      </DragOverlay>,
        document.body
      )}
      <Dialog
        open={createOpen !== null}
        onOpenChange={(open) => {
          if (!open) setCreateOpen(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {createOpen === "category"
                ? "New category"
                : createOpen === "voice"
                  ? "New voice channel"
                  : "New text channel"}
            </DialogTitle>
            <DialogDescription>
              {createOpen === "category"
                ? "Group related channels under a label. Categories can be reordered after creation."
                : "Lowercase letters, numbers, and dashes recommended."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3 py-2"
            onSubmit={(event) => {
              event.preventDefault()
              void submitCreate()
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cs-create-channel-name">
                {createOpen === "category" ? "Category name" : "Channel name"}
              </Label>
              <Input
                id="cs-create-channel-name"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                disabled={createBusy}
                placeholder={createOpen === "category" ? "general" : "general"}
              />
            </div>
            {createError ? (
              <div className="text-sm text-destructive">{createError}</div>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setCreateOpen(null)}
                disabled={createBusy}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createBusy || !createName.trim()}>
                {createBusy
                  ? "Creating…"
                  : createOpen === "category"
                    ? "Create category"
                    : createOpen === "voice"
                      ? "Create voice channel"
                      : "Create text channel"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </DndContext>
  )
}

function sameChannelOrder(left: Channel[], right: Channel[]): boolean {
  if (left.length !== right.length) return false
  return left.every(
    (channel, index) =>
      channel.id === right[index]?.id &&
      channel.categoryId === right[index]?.categoryId
  )
}

function RootChannelsZone({
  channels,
  activeChannelId,
  onSelect,
  onDeleteChannel,
  canAdministrate,
}: {
  channels: Channel[]
  activeChannelId: string
  onSelect: (id: string) => void
  onDeleteChannel?: (channelId: string) => Promise<void>
  canAdministrate: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: ROOT_DROPPABLE_ID,
    data: { accepts: ["channel"] satisfies DraggedKind[] },
  })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex flex-col rounded-md transition-colors",
        isOver && "bg-sidebar-accent/50",
        channels.length === 0 && "min-h-2"
      )}
    >
      <SortableContext
        items={channels.map((c) => c.id)}
        strategy={verticalListSortingStrategy}
      >
        <SidebarMenu className="gap-0.5">
          {channels.map((channel) => (
            <SortableChannel
              key={channel.id}
              channel={channel}
              isActive={channel.id === activeChannelId}
              onSelect={() => onSelect(channel.id)}
              onDeleteChannel={onDeleteChannel}
              canAdministrate={canAdministrate}
            />
          ))}
        </SidebarMenu>
      </SortableContext>
    </div>
  )
}

function SortableCategory({
  category,
  channels,
  activeChannelId,
  onSelect,
  onDeleteChannel,
  onDeleteCategory,
  canAdministrate,
  onCreateTextChannel,
}: {
  category: ChannelCategory
  channels: Channel[]
  activeChannelId: string
  onSelect: (id: string) => void
  onDeleteChannel?: (channelId: string) => Promise<void>
  onDeleteCategory?: (categoryId: string) => Promise<void>
  canAdministrate: boolean
  onCreateTextChannel?: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: category.id,
    data: {
      kind: "category" satisfies DraggedKind,
      categoryId: category.id,
      accepts: ["category"] satisfies DraggedKind[],
    },
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  // Droppable zone for the category content (accepts channels)
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `cat-zone-${category.id}`,
    data: {
      kind: "category" satisfies DraggedKind,
      isContainer: true,
      accepts: ["channel"] satisfies DraggedKind[],
    },
  })

  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleteBusy, setDeleteBusy] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)
  const canDeleteCategory = canAdministrate && Boolean(onDeleteCategory)

  const confirmDelete = React.useCallback(async () => {
    if (!onDeleteCategory) return
    // Close the dialog BEFORE awaiting the mutation. The mutation
    // triggers a `channel_deleted` WS broadcast that drops this
    // category from the list, which unmounts SortableCategory while
    // the AlertDialog is still mid-close. That race leaves Radix's
    // body `pointer-events: none` lock in place and freezes every
    // future click until a hard reload.
    setDeleteError(null)
    setDeleteOpen(false)
    setDeleteBusy(true)
    try {
      await onDeleteCategory(category.id)
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete category"
      )
      setDeleteOpen(true)
    } finally {
      setDeleteBusy(false)
    }
  }, [category.id, onDeleteCategory])

  return (
    <div ref={setNodeRef} style={style}>
      <Collapsible defaultOpen className="group/category">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="flex items-center justify-between px-2 py-1">
              <button
                type="button"
                {...attributes}
                {...listeners}
                className="flex size-4 cursor-grab items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-opacity hover:text-foreground active:cursor-grabbing group-hover/category:opacity-100"
                aria-label={`Drag ${category.name}`}
              >
                <GripVerticalIcon className="size-3" />
              </button>
              <CollapsibleTrigger className="flex flex-1 items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/80 transition-colors hover:text-foreground">
                <ChevronDownIcon className="size-3 transition-transform duration-200 group-data-[state=closed]/category:-rotate-90" />
                <span>{category.name}</span>
              </CollapsibleTrigger>
              <Button
                variant="ghost"
                size="icon-xs"
                title={`Add channel to ${category.name}`}
                className="text-muted-foreground/70 hover:bg-sidebar-accent hover:text-foreground"
                disabled={!onCreateTextChannel}
                onClick={onCreateTextChannel}
              >
                <PlusIcon />
              </Button>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-48">
            <ContextMenuItem
              variant="destructive"
              disabled={!canDeleteCategory}
              onSelect={() => {
                // Defer dialog open to the next tick, opening
                // synchronously while ContextMenu is still tearing
                // down stacks two Radix overlays and leaves `<body>`
                // with `pointer-events: none` once both close.
                setTimeout(() => {
                  setDeleteError(null)
                  setDeleteOpen(true)
                }, 0)
              }}
            >
              <TrashIcon className="size-4" />
              Delete category
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <CollapsibleContent>
          <div
            ref={setDropRef}
            className={cn(
              "rounded-md transition-colors",
              isOver && "bg-sidebar-accent/50",
              channels.length === 0 && "min-h-6"
            )}
          >
            <SortableContext
              items={channels.map((c) => c.id)}
              strategy={verticalListSortingStrategy}
            >
              <SidebarMenu className="gap-0.5">
                {channels.map((channel) => (
                  <SortableChannel
                    key={channel.id}
                    channel={channel}
                    isActive={channel.id === activeChannelId}
                    onSelect={() => onSelect(channel.id)}
                    onDeleteChannel={onDeleteChannel}
                    canAdministrate={canAdministrate}
                  />
                ))}
              </SidebarMenu>
            </SortableContext>
          </div>
        </CollapsibleContent>
      </Collapsible>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {category.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {channels.length > 0
                ? `This permanently deletes the category and the ${channels.length} channel${channels.length === 1 ? "" : "s"} inside it, along with their messages. Cannot be undone.`
                : "This permanently deletes the category. Cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <div className="text-sm text-destructive">{deleteError}</div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteBusy}
              onClick={(event) => {
                event.preventDefault()
                void confirmDelete()
              }}
            >
              {deleteBusy ? "Deleting..." : "Delete category"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function SortableChannel({
  channel,
  isActive,
  onSelect,
  onDeleteChannel,
  canAdministrate,
}: {
  channel: Channel
  isActive: boolean
  onSelect: () => void
  onDeleteChannel?: (channelId: string) => Promise<void>
  canAdministrate: boolean
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: channel.id,
    data: {
      kind: "channel" satisfies DraggedKind,
      categoryId: channel.categoryId,
      accepts: ["channel"] satisfies DraggedKind[],
    },
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  }

  // Mockup parity: no visible grip handle on channel rows. The whole
  // row is the drag target via {attributes,listeners} on the outer
  // div. Categories keep their hover-revealed handle. The reason
  // matters beyond aesthetics: with a separate handle button the row
  // hosts two clickable surfaces (drag handle + ChannelButton) that
  // race for pointer events on the hover edge, which on touchpads
  // intermittently captures a drag instead of a click. Keeping drag
  // attached to the row only is also what the prototype validated.
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="min-w-0"
    >
      <ChannelButton
        channel={channel}
        isActive={isActive}
        onSelect={onSelect}
        onDeleteChannel={onDeleteChannel}
        canAdministrate={canAdministrate}
      />
    </div>
  )
}

function ChannelButton({
  channel,
  isActive,
  onSelect,
  onDeleteChannel,
  canAdministrate = false,
  isDragging,
}: {
  channel: Channel
  isActive: boolean
  onSelect: () => void
  onDeleteChannel?: (channelId: string) => Promise<void>
  canAdministrate?: boolean
  isDragging?: boolean
}) {
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleteBusy, setDeleteBusy] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)
  const hasParticipants =
    channel.kind === "voice" && (channel.participants?.length ?? 0) > 0
  const canDelete = canAdministrate && Boolean(onDeleteChannel)

  const confirmDelete = React.useCallback(async () => {
    if (!onDeleteChannel) return
    // Close the dialog BEFORE awaiting the mutation. The mutation
    // triggers a `channel_deleted` WS broadcast that drops this
    // channel from the list, which unmounts SortableChannel while
    // the AlertDialog is still mid-close. That race leaves Radix's
    // body `pointer-events: none` lock in place and freezes every
    // future click until a hard reload.
    setDeleteError(null)
    setDeleteOpen(false)
    setDeleteBusy(true)
    try {
      await onDeleteChannel(channel.id)
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete channel"
      )
      setDeleteOpen(true)
    } finally {
      setDeleteBusy(false)
    }
  }, [channel.id, onDeleteChannel])

  return (
    <>
      <ContextMenu>
        <SidebarMenuItem className={cn(isDragging && "rounded-md bg-card shadow-lg")}>
          <ContextMenuTrigger asChild>
            <SidebarMenuButton isActive={isActive} onClick={onSelect}>
              {channel.kind === "voice" ? <Volume2Icon /> : <HashIcon />}
              <span>{channel.name}</span>
            </SidebarMenuButton>
          </ContextMenuTrigger>
          {channel.mentionCount && channel.mentionCount > 0 ? (
            <SidebarMenuBadge className="bg-primary text-primary-foreground peer-data-active/menu-button:text-primary-foreground peer-hover/menu-button:text-primary-foreground">
              {channel.mentionCount > 99 ? "99+" : channel.mentionCount}
            </SidebarMenuBadge>
          ) : channel.unreadCount && channel.unreadCount > 0 ? (
            <SidebarMenuBadge className="bg-muted text-muted-foreground peer-data-active/menu-button:text-foreground peer-hover/menu-button:text-foreground">
              {channel.unreadCount > 99 ? "99+" : channel.unreadCount}
            </SidebarMenuBadge>
          ) : null}
        </SidebarMenuItem>
        <ContextMenuContent className="w-48">
          <ContextMenuItem disabled>
            <SettingsIcon className="size-4" />
            Channel settings
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            disabled={!canDelete}
            onSelect={() => {
              // Defer dialog open to the next tick, opening
              // synchronously while ContextMenu is still tearing
              // down stacks two Radix overlays and leaves `<body>`
              // with `pointer-events: none` once both close.
              setTimeout(() => {
                setDeleteError(null)
                setDeleteOpen(true)
              }, 0)
            }}
          >
            <TrashIcon className="size-4" />
            Delete channel
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete #{channel.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the channel and its messages. Cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <div className="text-sm text-destructive">{deleteError}</div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteBusy}
              onClick={(event) => {
                event.preventDefault()
                void confirmDelete()
              }}
            >
              {deleteBusy ? "Deleting..." : "Delete channel"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {hasParticipants ? (
        <VoiceParticipantsGroup participants={channel.participants!} />
      ) : null}
    </>
  )
}

function VoiceParticipantsGroup({
  participants,
}: {
  participants: VoiceParticipant[]
}) {
  // Named roster: every connected participant gets a full-width row with
  // their avatar initial, full display name, and a trailing mute/deafen
  // badge. Replaces the earlier compact overlapping-avatar stack so the
  // display name is always visible while in the voice channel.
  return (
    <ul className="flex flex-col gap-0.5 pb-1 pl-7 pr-2 pt-1">
      {participants.map((participant) => (
        <li
          key={participant.id}
          className="flex items-center gap-2 py-0.5"
        >
          <span
            className={
              "relative flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-medium " +
              (participant.isSpeaking ? "ring-2 ring-primary/60" : "")
            }
          >
            {participant.initials}
          </span>
          <span
            className={
              "flex-1 truncate text-xs " +
              (participant.isSpeaking
                ? "font-medium text-foreground"
                : "text-sidebar-foreground/80")
            }
          >
            {participant.name}
          </span>
          {/* Deafened wins over muted: deaf implies mic muted, and the
              headphone-off pictogram already says "no audio in/out". */}
          {participant.isDeafened ? (
            <HeadphoneOffIcon className="size-3 shrink-0 text-muted-foreground" />
          ) : participant.isMuted ? (
            <MicOffIcon className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function AppsSection({ apps }: { apps: AppEntry[] }) {
  return (
    <SidebarGroup className="mt-auto">
      <SidebarGroupLabel>Apps</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.5">
          {apps.map((app) => (
            <SidebarMenuItem key={app.id}>
              <SidebarMenuButton>
                {app.icon}
                <span>{app.name}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

export type { Channel, ChannelCategory, SystemChannel, AppEntry }
export { ScrollTextIcon, ShieldAlertIcon, PuzzleIcon }
