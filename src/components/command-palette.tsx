import * as React from "react"
import {
  HashIcon,
  Volume2Icon,
  HomeIcon,
  MicOffIcon,
  SettingsIcon,
  LogOutIcon,
  PlusIcon,
  CompassIcon,
  UserPlusIcon,
  ShieldAlertIcon,
  KeyboardIcon,
  RefreshCwIcon,
} from "lucide-react"

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"

interface ChannelEntry {
  id: string
  name: string
  kind: "text" | "voice"
  serverId: string
  serverName: string
}

interface ServerEntry {
  id: string
  name: string
}

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  channels: ChannelEntry[]
  servers: ServerEntry[]
  onJumpServer: (id: string) => void
  onJumpChannel: (channel: ChannelEntry) => void
  onToggleMute: () => void
  onGoHome: () => void
  onOpenCheatSheet: () => void
  onDiscoverServers?: () => void
  onCreateServer?: () => void
  /**
   * Open the create-channel / create-category dialog on the active
   * server. Set only when (a) a server is in focus AND (b) the user
   * can administrate it; absent otherwise so the palette items render
   * disabled. The handler dispatches a window-level event the
   * channel-sidebar listens to, avoiding a global state lift just to
   * cross-component-call into the existing dialog.
   */
  onCreateChannel?: (kind: "text" | "voice" | "category") => void
  onOpenSettings?: () => void
  onCheckForUpdates?: () => void | Promise<void>
  onSignOut?: () => void | Promise<void>
}

export function CommandPalette({
  open,
  onOpenChange,
  channels,
  servers,
  onJumpServer,
  onJumpChannel,
  onToggleMute,
  onGoHome,
  onOpenCheatSheet,
  onDiscoverServers,
  onCreateServer,
  onCreateChannel,
  onOpenSettings,
  onCheckForUpdates,
  onSignOut,
}: CommandPaletteProps) {
  const [query, setQuery] = React.useState("")
  const isSearching = query.trim().length > 0

  React.useEffect(() => {
    if (!open) setQuery("")
  }, [open])

  function runAction(callback: () => void) {
    return () => {
      callback()
      onOpenChange(false)
    }
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <Command>
        <CommandInput
          placeholder="Type a command or search a server / channel…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>No matches.</CommandEmpty>

          <CommandGroup heading="Navigazione">
            <CommandItem onSelect={runAction(onGoHome)}>
              <HomeIcon />
              <span>Go to Home</span>
            </CommandItem>
            {isSearching
              ? servers.map((server) => (
                  <CommandItem
                    key={`nav-server-${server.id}`}
                    value={`server ${server.name}`}
                    onSelect={runAction(() => onJumpServer(server.id))}
                  >
                    <span className="flex size-5 items-center justify-center rounded-md bg-sidebar-accent text-[10px] font-semibold">
                      {server.name.slice(0, 2).toUpperCase()}
                    </span>
                    <span>{server.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      Server
                    </span>
                  </CommandItem>
                ))
              : null}
            {isSearching
              ? channels.map((channel) => (
                  <CommandItem
                    key={`nav-channel-${channel.serverId}/${channel.id}`}
                    value={`channel ${channel.serverName} ${channel.name}`}
                    onSelect={runAction(() => onJumpChannel(channel))}
                  >
                    {channel.kind === "voice" ? (
                      <Volume2Icon />
                    ) : (
                      <HashIcon />
                    )}
                    <span>{channel.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {channel.serverName}
                    </span>
                  </CommandItem>
                ))
              : null}
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Server actions">
            <CommandItem
              disabled={!onCreateServer}
              onSelect={runAction(() => onCreateServer?.())}
            >
              <PlusIcon />
              <span>Create server</span>
            </CommandItem>
            <CommandItem
              disabled={!onCreateChannel}
              onSelect={runAction(() => onCreateChannel?.("text"))}
            >
              <HashIcon />
              <span>Create channel</span>
            </CommandItem>
            <CommandItem
              disabled={!onCreateChannel}
              onSelect={runAction(() => onCreateChannel?.("category"))}
            >
              <PlusIcon />
              <span>Create category</span>
            </CommandItem>
            {/* Discover is gated behind the instance-level discovery
                index, which is not yet shipping. Render disabled+muted
                so the affordance signals "shipping soon" without
                reaching the placeholder route. */}
            <CommandItem disabled>
              <CompassIcon />
              <span>Discover servers</span>
              <span className="ml-auto text-xs text-muted-foreground">
                Shipping soon
              </span>
            </CommandItem>
            {/* Per-channel invite already lives in the channel-sidebar
                dropdown; instance-level ban requires admin guard + user
                picker. Both render disabled to match prototype 1:1. */}
            <CommandItem disabled>
              <UserPlusIcon />
              <span>Invite user</span>
            </CommandItem>
            <CommandItem
              disabled
              className="text-destructive data-selected:bg-destructive/10 data-selected:text-destructive"
            >
              <ShieldAlertIcon />
              <span>Ban user</span>
            </CommandItem>
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Preferenze">
            <CommandItem onSelect={runAction(onToggleMute)}>
              <MicOffIcon />
              <span>Toggle mute</span>
              <CommandShortcut>⌘ ⇧ M</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={runAction(onOpenCheatSheet)}>
              <KeyboardIcon />
              <span>Keyboard shortcuts</span>
              <CommandShortcut>⌘ /</CommandShortcut>
            </CommandItem>
            <CommandItem
              disabled={!onOpenSettings}
              onSelect={runAction(() => onOpenSettings?.())}
            >
              <SettingsIcon />
              <span>Open settings</span>
            </CommandItem>
            <CommandItem
              disabled={!onCheckForUpdates}
              onSelect={runAction(() => {
                void onCheckForUpdates?.()
              })}
            >
              <RefreshCwIcon />
              <span>Check for updates</span>
            </CommandItem>
            <CommandItem
              disabled={!onSignOut}
              onSelect={runAction(() => {
                void onSignOut?.()
              })}
              className="text-destructive data-selected:bg-destructive/10 data-selected:text-destructive"
            >
              <LogOutIcon />
              <span>Sign out</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
