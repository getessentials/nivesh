import { Info } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/** A step can be a plain instruction, or a link out (e.g. to the source site). */
export interface HelpStep {
  text: string;
  href?: string;
}

/** Small info-icon trigger that opens a numbered how-to dialog — for manual steps the owner
 *  has to do outside the app (docs/12 §7). Click-to-open, not hover, so it works on mobile too. */
export function HelpStepsDialog({ title, description, steps }: { title: string; description?: string; steps: HelpStep[] }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="size-5 -my-1" aria-label={`How to: ${title}`}>
          <Info className="size-4 text-muted-foreground" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <ol className="space-y-2 text-sm list-decimal list-inside">
          {steps.map((step, i) => (
            <li key={i}>
              {step.text}
              {step.href && (
                <>
                  {' '}
                  <a href={step.href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
                    {step.href}
                  </a>
                </>
              )}
            </li>
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  );
}
