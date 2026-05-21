import * as React from "react"
import {
  BellIcon,
  ChevronsUpDownIcon,
  LogOutIcon,
  SettingsIcon,
} from "lucide-react"
import { toast } from "sonner"

import {
  Avatar,
  AvatarFallback,
} from "@/components/ui/avatar"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { UsernameHandle } from "@/components/identity/username-handle"

export interface UserMenuUser {
  name: string
  username: string
  initials: string
}

interface UserMenuProps {
  user: UserMenuUser
  onOpenSettings?: () => void
  onSignOut?: () => void | Promise<void>
  utilityAction?: React.ReactNode
}

export function UserMenu({
  user,
  onOpenSettings,
  onSignOut,
  utilityAction,
}: UserMenuProps) {
  const [logoutOpen, setLogoutOpen] = React.useState(false)
  const [logoutBusy, setLogoutBusy] = React.useState(false)

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="flex items-center gap-1 px-1 py-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="h-14 min-w-0 flex-1 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <Avatar className="size-8 rounded-lg">
                  <AvatarFallback className="rounded-lg">
                    {user.initials}
                  </AvatarFallback>
                </Avatar>
                <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user.name}</span>
                  {user.username ? (
                    <UsernameHandle
                      username={user.username}
                      className="text-xs text-muted-foreground"
                    />
                  ) : null}
                </div>
                <ChevronsUpDownIcon className="ml-auto size-4 opacity-70" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
              side="top"
              align="end"
              sideOffset={4}
            >
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {user.username ? (
                  <UsernameHandle username={user.username} />
                ) : (
                  user.name
                )}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  onSelect={() => {
                    // Defer the dialog open so the DropdownMenu can
                    // finish its close + body pointer-events restore
                    // before the Dialog mounts. Stacking two Radix
                    // overlays leaks the body lock on dismiss and
                    // freezes the UI until reload. Same pattern as the
                    // logout AlertDialog below.
                    setTimeout(() => onOpenSettings?.(), 0)
                  }}
                >
                  <SettingsIcon className="size-4" />
                  Preferences
                </DropdownMenuItem>
                {/* Notifications has no per-user prefs backend yet — render
                    disabled to keep parity with the prototype. */}
                <DropdownMenuItem disabled>
                  <BellIcon className="size-4" />
                  Notifications
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  // Defer to next tick so the DropdownMenu finishes its
                  // close + body pointer-events restore before the
                  // AlertDialog mounts. Stacking two Radix overlays leaks
                  // the body lock on dismiss and freezes the UI until
                  // a hard reload.
                  setTimeout(() => setLogoutOpen(true), 0)
                }}
              >
                <LogOutIcon className="size-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {utilityAction ? (
            <div className="shrink-0 self-center">{utilityAction}</div>
          ) : null}
        </div>
      </SidebarMenuItem>
      <AlertDialog open={logoutOpen} onOpenChange={setLogoutOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Log out?</AlertDialogTitle>
            <AlertDialogDescription>
              You will be signed out on this device. Active voice calls will
              disconnect.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={logoutBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={logoutBusy}
              onClick={(event) => {
                event.preventDefault()
                if (!onSignOut) {
                  setLogoutOpen(false)
                  return
                }
                // Close the dialog before the awaited signout so the
                // Radix portal cleanup completes before the auth flow
                // unmounts this tree. Same close-before-await pattern
                // used elsewhere for destructive actions.
                setLogoutOpen(false)
                setLogoutBusy(true)
                Promise.resolve(onSignOut())
                  .catch((err) => {
                    const message =
                      err instanceof Error && err.message
                        ? err.message
                        : "Logout failed. Try again."
                    toast.error(message)
                  })
                  .finally(() => setLogoutBusy(false))
              }}
            >
              {logoutBusy ? "Logging out..." : "Log out"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarMenu>
  )
}
