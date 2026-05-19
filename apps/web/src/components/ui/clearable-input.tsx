import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface ClearableInputProps {
  clearLabel: string;
  disabled?: boolean;
  maxLength?: number;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
  className?: string;
}

export function ClearableInput({
  clearLabel,
  disabled,
  maxLength,
  onChange,
  placeholder,
  value,
  className,
}: ClearableInputProps) {
  return (
    <div className={cn('relative w-full sm:w-[260px]', className)}>
      <Input
        className="pr-9"
        maxLength={maxLength}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
      />
      {value.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          onClick={() => onChange('')}
          disabled={disabled}
          aria-label={clearLabel}
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
