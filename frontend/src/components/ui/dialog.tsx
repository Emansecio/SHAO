import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

function DialogContent({ className, children, onOpenAutoFocus, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_160ms_ease-out]" />
      <DialogPrimitive.Content
        tabIndex={-1}
        onOpenAutoFocus={
          onOpenAutoFocus ??
          ((e) => {
            // foco no próprio diálogo, não no primeiro link interno
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus();
          })
        }
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex max-h-[min(86vh,720px)] w-[min(92vw,640px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line-strong bg-ink-900 shadow-2xl shadow-black/60 outline-none data-[state=open]:animate-[dialog-in_200ms_cubic-bezier(.2,.8,.2,1)]",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute right-3 top-3 grid size-7 place-items-center rounded-md text-fg-faint transition-colors hover:bg-white/5 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          aria-label="Fechar"
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

const DialogTitle = DialogPrimitive.Title;
const DialogDescription = DialogPrimitive.Description;

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogTitle, DialogDescription };
