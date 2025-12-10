"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          "textarea-base min-h-[140px] font-medium leading-6",
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

