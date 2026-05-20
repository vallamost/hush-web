import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx"
import { Separator } from "@/components/ui/separator.tsx"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx"

interface CheatSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  isMac?: boolean
}

interface ShortcutEntry {
  keys: string[]
  label: string
  global?: boolean
}

interface ShortcutSection {
  id: string
  title: string
  description: string
  entries: ShortcutEntry[]
}

const MOD = "⌘"
const SHIFT = "⇧"
const ALT_MAC = "⌥"

function buildSections(modKey: string, altKey: string): ShortcutSection[] {
  return [
    {
      id: "voice",
      title: "Voice",
      description: "Global system-wide controls (desktop build)",
      entries: [
        { keys: [modKey, SHIFT, "M"], label: "Toggle mute", global: true },
        {
          keys: [modKey, SHIFT, "D"],
          label: "Toggle deafen",
          global: true,
        },
        {
          keys: ["Mouse 4", "Right Alt"],
          label: "Push-to-talk (PTT)",
          global: true,
        },
        {
          keys: [modKey, SHIFT, "H"],
          label: "Show / hide Hush",
          global: true,
        },
      ],
    },
    {
      id: "navigation",
      title: "Navigation",
      description: "Warp drive across servers and channels",
      entries: [
        { keys: [modKey, "K"], label: "Open command palette" },
        { keys: [altKey, "↑"], label: "Previous channel" },
        { keys: [altKey, "↓"], label: "Next channel" },
        { keys: [modKey, "1 … 9"], label: "Jump to server N" },
        { keys: [modKey, "["], label: "Back in history" },
        { keys: [modKey, "]"], label: "Forward in history" },
      ],
    },
    {
      id: "inbox",
      title: "Inbox",
      description: "Sweep notifications without anxiety",
      entries: [
        { keys: ["Esc"], label: "Mark current channel as read" },
        { keys: [SHIFT, "Esc"], label: "Mark whole server as read" },
        { keys: [altKey, "Click"], label: "Mark message as unread" },
      ],
    },
    {
      id: "chat",
      title: "Chat",
      description: "Tactical composer shortcuts",
      entries: [
        { keys: ["Enter"], label: "Send message" },
        { keys: [SHIFT, "Enter"], label: "Newline / new block" },
        { keys: ["↑"], label: "Edit last message (empty composer)" },
        { keys: ["R"], label: "Reply in thread on focused message" },
        { keys: ["/"], label: "Open slash menu" },
      ],
    },
    {
      id: "misc",
      title: "Misc",
      description: "Settings and this sheet",
      entries: [
        { keys: [modKey, "/"], label: "Open this cheat sheet" },
      ],
    },
  ]
}

export function CheatSheet({
  open,
  onOpenChange,
  isMac = true,
}: CheatSheetProps) {
  const modKey = isMac ? MOD : "Ctrl"
  const altKey = isMac ? ALT_MAC : "Alt"
  const sections = buildSections(modKey, altKey)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Hush is built keyboard-first. Switch between sections to learn the
            full surface.
          </DialogDescription>
        </DialogHeader>
        <Separator />
        <Tabs defaultValue={sections[0].id} className="gap-0">
          <TabsList className="mx-6 mt-4 mb-2 w-auto justify-start">
            {sections.map((section) => (
              <TabsTrigger key={section.id} value={section.id}>
                {section.title}
              </TabsTrigger>
            ))}
          </TabsList>
          {sections.map((section) => (
            <TabsContent
              key={section.id}
              value={section.id}
              className="px-6 pt-2 pb-6"
            >
              <p className="mb-4 text-sm text-muted-foreground">
                {section.description}
              </p>
              <div className="h-56 overflow-y-auto overscroll-contain [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent">
                <ul className="flex flex-col">
                  {section.entries.map((entry, idx) => (
                    <li key={entry.label}>
                      {idx > 0 ? <Separator /> : null}
                      <div className="flex items-center justify-between gap-4 py-2.5">
                        <span className="flex min-w-0 items-center gap-2 text-sm">
                          <span className="truncate">{entry.label}</span>
                          {entry.global ? (
                            <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                              global
                            </span>
                          ) : null}
                        </span>
                        <KeyCombo keys={entry.keys} />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </TabsContent>
          ))}
        </Tabs>
        <Separator />
        <p className="px-6 py-3 text-[11px] text-muted-foreground">
          Global shortcuts require the Hush desktop build (Tauri / Electron).
          The web version covers in-app shortcuts only.
        </p>
      </DialogContent>
    </Dialog>
  )
}

function KeyCombo({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {keys.map((key, idx) => (
        <span key={`${key}-${idx}`} className="flex items-center">
          {idx > 0 ? (
            <span className="px-0.5 text-[10px] text-muted-foreground">+</span>
          ) : null}
          <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border bg-muted px-1.5 font-mono text-[11px] font-medium text-foreground">
            {key}
          </kbd>
        </span>
      ))}
    </span>
  )
}
