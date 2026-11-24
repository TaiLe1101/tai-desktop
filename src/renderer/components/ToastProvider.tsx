import Close from '@mui/icons-material/Close';
import { Box, Button, IconButton, Paper, Snackbar, Stack, Typography } from '@mui/material';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastSeverity = 'error' | 'warning' | 'success' | 'info';

export interface ToastOptions {
  message: string;
  severity?: ToastSeverity;
  actionLabel?: string;
  onAction?: () => void;
  autoHideDuration?: number;
  dedupeKey?: string;
}

interface ToastItem extends ToastOptions {
  id: number;
  severity: ToastSeverity;
}

interface ToastContextValue {
  notify: (options: ToastOptions) => void;
  closeToast: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const SEVERITY_STYLES: Record<ToastSeverity, { border: string; bg: string; accent: string; label: string }> = {
  error: {
    border: 'rgba(248, 113, 113, 0.55)',
    bg: '#231319',
    accent: '#f87171',
    label: 'Lỗi'
  },
  warning: {
    border: 'rgba(251, 191, 36, 0.55)',
    bg: '#241d11',
    accent: '#fbbf24',
    label: 'Lưu ý'
  },
  success: {
    border: 'rgba(74, 222, 128, 0.55)',
    bg: '#102419',
    accent: '#4ade80',
    label: 'Thành công'
  },
  info: {
    border: 'rgba(152, 186, 255, 0.55)',
    bg: '#121d2e',
    accent: '#98baff',
    label: 'Thông báo'
  }
};

const DEFAULT_AUTO_HIDE_MS = 4500;
const ACTION_AUTO_HIDE_MS = 7500;
const DEDUPE_WINDOW_MS = 2500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ToastItem | null>(null);
  const [open, setOpen] = useState(false);
  const nextId = useRef(1);
  const lastShown = useRef<{ key: string; at: number }>({ key: '', at: 0 });
  const openRef = useRef(false);
  openRef.current = open;

  const closeToast = useCallback(() => {
    setOpen(false);
  }, []);

  const notify = useCallback((options: ToastOptions) => {
    const message = (options.message || '').trim();
    if (!message) return;
    const severity: ToastSeverity = options.severity || 'info';
    const key = options.dedupeKey || `${severity}|${message}`;
    const now = Date.now();
    if (lastShown.current.key === key && (openRef.current || now - lastShown.current.at < DEDUPE_WINDOW_MS)) {
      return;
    }
    lastShown.current = { key, at: now };
    setCurrent({
      ...options,
      id: nextId.current++,
      message,
      severity
    });
    setOpen(true);
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ notify, closeToast }), [notify, closeToast]);
  const palette = current ? SEVERITY_STYLES[current.severity] : SEVERITY_STYLES.info;
  const duration = current?.autoHideDuration
    ?? (current?.actionLabel ? ACTION_AUTO_HIDE_MS : DEFAULT_AUTO_HIDE_MS);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Snackbar
        key={current?.id}
        open={open && Boolean(current)}
        autoHideDuration={duration}
        onClose={(_event, reason) => {
          if (reason === 'clickaway') return;
          setOpen(false);
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        sx={{
          mr: 0.5,
          mb: 0.5,
          maxWidth: 332,
          zIndex: 1600,
          '& .MuiSnackbarContent-root': { borderRadius: '12px' }
        }}
      >
        <Paper
          elevation={8}
          role="status"
          sx={{
            width: '100%',
            maxWidth: 332,
            px: 1.5,
            py: 1.2,
            borderRadius: '12px',
            overflow: 'hidden',
            bgcolor: palette.bg,
            border: `1px solid ${palette.border}`,
            borderLeft: `4px solid ${palette.accent}`,
            color: '#f1f5f9',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.55)'
          }}
        >
          <Stack direction="row" sx={{ alignItems: 'flex-start', gap: 1 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="caption"
                sx={{ color: palette.accent, fontWeight: 700, display: 'block', lineHeight: 1.2, mb: 0.3 }}
              >
                {palette.label}
              </Typography>
              <Typography variant="body2" sx={{ fontSize: 13, lineHeight: 1.4, wordBreak: 'break-word' }}>
                {current?.message}
              </Typography>
              {current?.actionLabel && current.onAction && (
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => {
                    const cb = current.onAction;
                    setOpen(false);
                    cb?.();
                  }}
                  sx={{
                    mt: 1,
                    py: 0.25,
                    px: 1.2,
                    fontSize: 12,
                    borderColor: palette.accent,
                    color: palette.accent,
                    '&:hover': { borderColor: palette.accent, bgcolor: 'rgba(255,255,255,0.06)' }
                  }}
                >
                  {current.actionLabel}
                </Button>
              )}
            </Box>
            <IconButton
              size="small"
              aria-label="Đóng thông báo"
              onClick={() => setOpen(false)}
              sx={{ color: '#94a3b8', p: 0.3, mt: -0.2, '&:hover': { color: '#fff' } }}
            >
              <Close sx={{ fontSize: 16 }} />
            </IconButton>
          </Stack>
        </Paper>
      </Snackbar>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}
