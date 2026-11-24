import Check from '@mui/icons-material/Check';
import Close from '@mui/icons-material/Close';
import ContentCopy from '@mui/icons-material/ContentCopy';
import QrCode2 from '@mui/icons-material/QrCode2';
import WorkspacePremium from '@mui/icons-material/WorkspacePremium';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { formatUiError, formatVnd } from '../../shared/saas';
import type {
  EntitlementDto,
  PaymentConfigDto,
  PaymentOrderDto,
  PaymentOrderStatus,
  PlanDto,
  UpgradeRequestDto
} from '../../shared/types';
import { useToast } from './ToastProvider';

interface UpgradeModalProps {
  open: boolean;
  entitlement: EntitlementDto | null;
  onClose: () => void;
  onSubmitted?: () => void;
  onPaid?: () => void;
}

const POLL_INTERVAL_MS = 3_000;

const requestStatusLabel: Record<UpgradeRequestDto['status'], { label: string; color: 'warning' | 'success' | 'error' }> = {
  PENDING: { label: 'Đang chờ duyệt', color: 'warning' },
  APPROVED: { label: 'Đã duyệt', color: 'success' },
  REJECTED: { label: 'Từ chối', color: 'error' }
};

const orderStatusLabel: Record<PaymentOrderStatus, { label: string; color: 'warning' | 'success' | 'default' | 'error' }> = {
  PENDING: { label: 'Chờ thanh toán', color: 'warning' },
  PAID: { label: 'Đã thanh toán', color: 'success' },
  EXPIRED: { label: 'Đã hết hạn', color: 'default' },
  CANCELED: { label: 'Đã hủy', color: 'default' }
};

function formatCountdown(msRemaining: number): string {
  const totalSec = Math.max(0, Math.ceil(msRemaining / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function UpgradeModal({ open, entitlement, onClose, onSubmitted, onPaid }: UpgradeModalProps) {
  const { notify } = useToast();
  const [plans, setPlans] = useState<PlanDto[]>([]);
  const [requests, setRequests] = useState<UpgradeRequestDto[]>([]);
  const [orders, setOrders] = useState<PaymentOrderDto[]>([]);
  const [paymentConfig, setPaymentConfig] = useState<PaymentConfigDto>({
    sepayEnabled: false,
    bankCode: null,
    accountName: null,
    orderTtlMinutes: 15
  });

  const [paymentTab, setPaymentTab] = useState<'vietqr' | 'manual'>('vietqr');
  const [activeOrder, setActiveOrder] = useState<PaymentOrderDto | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [cancelingOrder, setCancelingOrder] = useState(false);
  const [billingCycle, setBillingCycle] = useState<'MONTHLY' | 'YEARLY'>('MONTHLY');
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const [contactNote, setContactNote] = useState('');

  const pollInFlight = useRef(false);
  const paidHandledRef = useRef<string | null>(null);

  const copyText = async (key: string, label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      notify({ severity: 'info', message: `Đã sao chép ${label.toLowerCase()}`, autoHideDuration: 2200, dedupeKey: `copy:${key}:${value}` });
      window.setTimeout(() => setCopiedKey(prev => (prev === key ? null : prev)), 1800);
    } catch {}
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const [planList, reqList, cfg, orderList] = await Promise.all([
        window.tai.listPublicPlans(),
        window.tai.listUpgradeRequests().catch(() => []),
        window.tai.getPaymentConfig().catch((): PaymentConfigDto => ({
          sepayEnabled: false,
          bankCode: null,
          accountName: null,
          orderTtlMinutes: 15
        })),
        window.tai.listPaymentOrders().catch(() => [])
      ]);

      setPlans(planList);
      setRequests(reqList);
      setPaymentConfig(cfg);
      setOrders(orderList);
      setPaymentTab(cfg.sepayEnabled ? 'vietqr' : 'manual');

      const existingPending = orderList.find(
        o => o.status === 'PENDING' && new Date(o.expiresAt).getTime() > Date.now()
      );
      if (existingPending && cfg.sepayEnabled) {
        setActiveOrder(existingPending);
        setSelectedPlanId(existingPending.planId);
        setBillingCycle(existingPending.billingCycle);
      } else {
        setActiveOrder(null);
        const currentPlanId = entitlement?.plan?.id;
        const defaultPick = planList.find(p => p.isHighlighted && p.id !== currentPlanId)
          || planList.find(p => p.priceMonthly > 0 && p.id !== currentPlanId)
          || planList[0];
        if (defaultPick) setSelectedPlanId(prev => prev ?? defaultPick.id);
      }
    } catch (err) {
      notify({ severity: 'error', message: formatUiError(err, 'Không tải được thông tin gói dịch vụ') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      paidHandledRef.current = null;
      void loadData();
    } else {
      setActiveOrder(null);
      pollInFlight.current = false;
    }
  }, [open]);

  // 1-second live countdown timer for active PENDING order
  useEffect(() => {
    if (!open || !activeOrder || activeOrder.status !== 'PENDING') {
      setRemainingMs(0);
      return;
    }
    const expiresMs = new Date(activeOrder.expiresAt).getTime();
    const updateRemaining = () => {
      const diff = Math.max(0, expiresMs - Date.now());
      setRemainingMs(diff);
      if (diff <= 0) {
        setActiveOrder(prev => {
          if (prev && prev.paymentCode === activeOrder.paymentCode && prev.status === 'PENDING') {
            notify({
              severity: 'warning',
              message: 'Đơn thanh toán đã hết hạn. Vui lòng tạo đơn mới.',
              dedupeKey: `order-expired:${activeOrder.paymentCode}`
            });
            return { ...prev, status: 'EXPIRED', qrUrl: null };
          }
          return prev;
        });
      }
    };
    updateRemaining();
    const timer = window.setInterval(updateRemaining, 1000);
    return () => window.clearInterval(timer);
  }, [open, activeOrder?.paymentCode, activeOrder?.status, activeOrder?.expiresAt, notify]);

  // 3-second payment status polling (pauses when document.hidden, stops on PAID/EXPIRED/CANCELED or close)
  useEffect(() => {
    if (!open || !activeOrder || activeOrder.status !== 'PENDING') return;
    const code = activeOrder.paymentCode;
    let disposed = false;

    const pollOnce = async () => {
      if (disposed || document.hidden || pollInFlight.current) return;
      pollInFlight.current = true;
      try {
        const st = await window.tai.getPaymentOrderStatus(code);
        if (disposed) return;
        if (st.status !== 'PENDING') {
          setActiveOrder(prev => (prev && prev.paymentCode === code
            ? {
                ...prev,
                status: st.status,
                paidAmount: st.paidAmount,
                paidAt: st.paidAt,
                qrUrl: null
              }
            : prev));
          setOrders(prev => prev.map(o => (o.paymentCode === code
            ? { ...o, status: st.status, paidAmount: st.paidAmount, paidAt: st.paidAt, qrUrl: null }
            : o)));

          if (st.status === 'PAID' && paidHandledRef.current !== code) {
            paidHandledRef.current = code;
            notify({
              severity: 'success',
              message: 'Thanh toán thành công — gói đã được kích hoạt!',
              dedupeKey: `order-paid:${code}`
            });
            await window.tai.refreshEntitlement().catch(() => null);
            onPaid?.();
            onSubmitted?.();
          } else if (st.status === 'EXPIRED') {
            notify({
              severity: 'warning',
              message: 'Đơn thanh toán đã hết hạn. Vui lòng tạo đơn mới.',
              dedupeKey: `order-expired:${code}`
            });
          } else if (st.status === 'CANCELED') {
            notify({
              severity: 'info',
              message: 'Đơn thanh toán đã được hủy.',
              dedupeKey: `order-canceled:${code}`
            });
          }
        }
      } catch {
        // Ignore transient poll errors; next tick will retry
      } finally {
        pollInFlight.current = false;
      }
    };

    const interval = window.setInterval(() => { void pollOnce(); }, POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (!document.hidden) void pollOnce();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [open, activeOrder?.paymentCode, activeOrder?.status, notify]);

  const selectedPlan = plans.find(p => p.id === selectedPlanId) || null;
  const selectedPrice = selectedPlan
    ? (billingCycle === 'YEARLY' ? selectedPlan.priceYearly : selectedPlan.priceMonthly)
    : 0;
  const isPaidPlanSelected = selectedPrice > 0;

  const handleCreateOrder = async () => {
    if (!selectedPlanId || !isPaidPlanSelected) return;
    setCreatingOrder(true);
    try {
      const order = await window.tai.createPaymentOrder({
        planId: selectedPlanId,
        billingCycle
      });
      setActiveOrder(order);
      setOrders(prev => [order, ...prev.filter(o => o.paymentCode !== order.paymentCode)]);
      notify({ severity: 'info', message: `Đã tạo đơn thanh toán ${order.paymentCode}. Vui lòng quét mã QR.` });
    } catch (err) {
      notify({ severity: 'error', message: formatUiError(err, 'Không thể tạo mã QR thanh toán') });
    } finally {
      setCreatingOrder(false);
    }
  };

  const handleCancelOrder = async () => {
    if (!activeOrder) return;
    setCancelingOrder(true);
    try {
      if (activeOrder.status === 'PENDING') {
        const res = await window.tai.cancelPaymentOrder(activeOrder.paymentCode);
        setOrders(prev => prev.map(o => (o.paymentCode === activeOrder.paymentCode
          ? { ...o, status: res.status, qrUrl: null }
          : o)));
        notify({ severity: 'info', message: `Đã hủy đơn thanh toán ${activeOrder.paymentCode}.` });
      }
      setActiveOrder(null);
    } catch (err) {
      notify({ severity: 'error', message: formatUiError(err, 'Không thể hủy đơn thanh toán') });
    } finally {
      setCancelingOrder(false);
    }
  };

  const handleManualSubmit = async () => {
    if (!selectedPlanId) return;
    setSubmitting(true);
    try {
      const created = await window.tai.createUpgradeRequest({
        planId: selectedPlanId,
        billingCycle,
        contactNote: contactNote.trim() || undefined
      });
      setRequests(prev => [created, ...prev]);
      setContactNote('');
      notify({
        severity: 'success',
        message: 'Đã gửi yêu cầu nâng cấp thành công! Quản trị viên sẽ liên hệ và kích hoạt gói sớm nhất.'
      });
      onSubmitted?.();
    } catch (err) {
      notify({ severity: 'error', message: formatUiError(err, 'Không thể gửi yêu cầu nâng cấp') });
    } finally {
      setSubmitting(false);
    }
  };

  const currentPlanId = entitlement?.plan?.id;
  const pendingRequest = requests.find(r => r.status === 'PENDING');
  const showQrImage = Boolean(
    activeOrder
    && activeOrder.status === 'PENDING'
    && activeOrder.qrUrl
    && remainingMs > 0
  );

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pb: 1 }}>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
          <WorkspacePremium color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 700 }}>Nâng cấp gói dịch vụ TAI Desktop</Typography>
        </Stack>
        <IconButton onClick={onClose} size="small" aria-label="Đóng"><Close /></IconButton>
      </DialogTitle>

      <DialogContent dividers>
        <Stack sx={{ gap: 2.5 }}>
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Gói hiện tại: <strong>{entitlement?.plan?.name || 'Chưa kích hoạt'}</strong>
              {entitlement?.tenant?.name ? ` · ${entitlement.tenant.name}` : ''}
            </Typography>
            <ToggleButtonGroup
              size="small"
              exclusive
              disabled={Boolean(activeOrder && activeOrder.status === 'PENDING')}
              value={billingCycle}
              onChange={(_e, val) => { if (val) setBillingCycle(val); }}
            >
              <ToggleButton value="MONTHLY">Theo tháng</ToggleButton>
              <ToggleButton value="YEARLY">Theo năm (Tiết kiệm)</ToggleButton>
            </ToggleButtonGroup>
          </Stack>

          {loading ? (
            <Box sx={{ display: 'grid', placeItems: 'center', py: 5 }}>
              <CircularProgress />
            </Box>
          ) : (
            <>
              {(!activeOrder || activeOrder.status !== 'PENDING') && (
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' }, gap: 2 }}>
                  {plans.map(plan => {
                    const isSelected = selectedPlanId === plan.id;
                    const isCurrent = currentPlanId === plan.id;
                    const price = billingCycle === 'YEARLY' ? plan.priceYearly : plan.priceMonthly;
                    const yearlySavePct = plan.priceMonthly > 0 && plan.priceYearly > 0
                      ? Math.max(0, Math.round((1 - plan.priceYearly / (plan.priceMonthly * 12)) * 100))
                      : 0;
                    return (
                      <Paper
                        key={plan.id}
                        variant="outlined"
                        onClick={() => setSelectedPlanId(plan.id)}
                        sx={{
                          p: 2,
                          cursor: 'pointer',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 1.2,
                          borderWidth: isSelected ? 2 : 1,
                          borderColor: isSelected ? 'primary.main' : plan.isHighlighted ? 'rgba(152,186,255,0.45)' : '#263242',
                          bgcolor: isSelected ? 'rgba(152,186,255,0.08)' : 'background.paper',
                          transition: 'border-color 0.15s ease, background-color 0.15s ease'
                        }}
                      >
                        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 0.5 }}>
                          <Typography sx={{ fontWeight: 700, fontSize: 16 }}>{plan.name}</Typography>
                          {isCurrent ? (
                            <Chip size="small" label="Đang dùng" color="success" />
                          ) : plan.badge ? (
                            <Chip size="small" label={plan.badge} color="primary" variant="outlined" />
                          ) : null}
                        </Stack>

                        <Box>
                          <Typography variant="h5" sx={{ fontWeight: 800, color: '#98baff' }}>
                            {formatVnd(price, plan.currency)}
                            {price > 0 && (
                              <Typography component="span" variant="caption" color="text.secondary">
                                {billingCycle === 'YEARLY' ? ' / năm' : ' / tháng'}
                              </Typography>
                            )}
                          </Typography>
                          {billingCycle === 'YEARLY' && yearlySavePct > 0 && (
                            <Typography variant="caption" color="success.main">Tiết kiệm {yearlySavePct}%</Typography>
                          )}
                        </Box>

                        <Typography variant="body2" color="text.secondary" sx={{ minHeight: 34 }}>
                          {plan.description || (plan.monthlyMinutesLimit === null
                            ? 'Không giới hạn phút lồng tiếng'
                            : `${plan.monthlyMinutesLimit.toLocaleString('vi-VN')} phút lồng tiếng / tháng`)}
                        </Typography>

                        <Divider />

                        <Stack sx={{ gap: 0.7, flex: 1 }}>
                          <Typography variant="caption" sx={{ fontWeight: 600 }}>
                            • Hạn mức: {plan.monthlyMinutesLimit === null ? 'Không giới hạn' : `${plan.monthlyMinutesLimit.toLocaleString('vi-VN')} phút/tháng`}
                          </Typography>
                          <Typography variant="caption" sx={{ fontWeight: 600 }}>
                            • Tối đa {plan.maxSeats} thành viên
                          </Typography>
                          {(plan.features || []).map((feat, idx) => (
                            <Stack key={idx} direction="row" sx={{ gap: 0.6, alignItems: 'flex-start' }}>
                              <Check sx={{ fontSize: 14, mt: '2px', color: 'primary.main', flexShrink: 0 }} />
                              <Typography variant="caption" color="text.secondary">{feat}</Typography>
                            </Stack>
                          ))}
                        </Stack>
                      </Paper>
                    );
                  })}
                </Box>
              )}

              {/* Payment Method Tabs */}
              <Box>
                <Tabs
                  value={paymentTab}
                  onChange={(_e, val) => setPaymentTab(val)}
                  sx={{ borderBottom: '1px solid #263242', mb: 2 }}
                >
                  <Tab
                    value="vietqr"
                    disabled={!paymentConfig.sepayEnabled}
                    icon={<QrCode2 fontSize="small" />}
                    iconPosition="start"
                    label={paymentConfig.sepayEnabled
                      ? 'Thanh toán tự động VietQR (kích hoạt ngay)'
                      : 'VietQR (Chưa cấu hình)'}
                  />
                  <Tab value="manual" label="Gửi yêu cầu nâng cấp thủ công" />
                </Tabs>

                {paymentTab === 'vietqr' && paymentConfig.sepayEnabled && (
                  <Stack sx={{ gap: 2 }}>
                    {!activeOrder ? (
                      <Paper variant="outlined" sx={{ p: 2.5, borderColor: '#263242' }}>
                        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
                          <Box>
                            <Typography sx={{ fontWeight: 700 }}>
                              {selectedPlan ? `Gói ${selectedPlan.name} (${billingCycle === 'YEARLY' ? 'Theo năm' : 'Theo tháng'})` : 'Chọn một gói trả phí'}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              {isPaidPlanSelected
                                ? `Số tiền: ${formatVnd(selectedPrice, selectedPlan?.currency)} · Quét VietQR và kích hoạt tự động trong vài giây.`
                                : 'Vui lòng chọn một gói trả phí (Pro / Team) để tạo mã QR thanh toán.'}
                            </Typography>
                          </Box>
                          <Button
                            variant="contained"
                            size="large"
                            startIcon={creatingOrder ? <CircularProgress size={18} color="inherit" /> : <QrCode2 />}
                            disabled={creatingOrder || !isPaidPlanSelected}
                            onClick={() => void handleCreateOrder()}
                          >
                            {creatingOrder ? 'Đang tạo mã QR…' : 'Tạo mã QR thanh toán'}
                          </Button>
                        </Stack>
                      </Paper>
                    ) : (
                      <Paper variant="outlined" sx={{ p: 2.5, borderColor: activeOrder.status === 'PAID' ? 'success.main' : 'primary.main' }}>
                        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2, flexWrap: 'wrap', gap: 1 }}>
                          <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                            <Typography sx={{ fontWeight: 700 }}>
                              Đơn thanh toán {activeOrder.paymentCode}
                            </Typography>
                            <Chip
                              size="small"
                              label={orderStatusLabel[activeOrder.status].label}
                              color={orderStatusLabel[activeOrder.status].color}
                            />
                          </Stack>
                          {activeOrder.status === 'PENDING' && (
                            <Chip
                              size="small"
                              variant="outlined"
                              color={remainingMs < 120_000 ? 'warning' : 'primary'}
                              label={`Hết hạn sau ${formatCountdown(remainingMs)}`}
                            />
                          )}
                        </Stack>

                        {activeOrder.status === 'PAID' ? (
                          <Stack sx={{ gap: 1.5 }}>
                            <Typography variant="body2" sx={{ color: 'success.main', fontWeight: 600 }}>
                              Thanh toán thành công — gói đã được kích hoạt! Số tiền nhận: {formatVnd(activeOrder.paidAmount ?? activeOrder.amount, activeOrder.currency)}.
                            </Typography>
                            <Stack direction="row" sx={{ justifyContent: 'flex-end' }}>
                              <Button variant="contained" onClick={onClose}>Hoàn tất</Button>
                            </Stack>
                          </Stack>
                        ) : activeOrder.status === 'EXPIRED' || activeOrder.status === 'CANCELED' ? (
                          <Stack sx={{ gap: 1.5 }}>
                            <Typography variant="body2" color="text.secondary">
                              {activeOrder.status === 'EXPIRED'
                                ? 'Đơn thanh toán đã hết hạn. Vui lòng không chuyển khoản theo mã cũ — hãy tạo đơn mới.'
                                : 'Đơn thanh toán đã được hủy.'}
                            </Typography>
                            <Stack direction="row" sx={{ justifyContent: 'flex-end', gap: 1 }}>
                              <Button variant="outlined" onClick={() => setActiveOrder(null)}>Chọn gói khác</Button>
                            </Stack>
                          </Stack>
                        ) : (
                          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '240px 1fr' }, gap: 2.5, alignItems: 'start' }}>
                            <Stack sx={{ alignItems: 'center', gap: 1 }}>
                              {showQrImage && activeOrder.qrUrl && (
                                <Box
                                  sx={{
                                    p: 1.5,
                                    bgcolor: '#ffffff',
                                    borderRadius: 2.5,
                                    boxShadow: '0 8px 24px rgba(0,0,0,0.4)'
                                  }}
                                >
                                  <Box
                                    component="img"
                                    src={activeOrder.qrUrl}
                                    alt={`VietQR ${activeOrder.paymentCode}`}
                                    sx={{ width: 210, height: 210, display: 'block', objectFit: 'contain' }}
                                  />
                                </Box>
                              )}
                              <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
                                Hệ thống tự động kiểm tra mỗi 3 giây…
                              </Typography>
                            </Stack>

                            <Stack sx={{ gap: 1.2 }}>
                              <Typography variant="body2" sx={{ color: '#fbbf24', fontWeight: 700 }}>
                                Vui lòng giữ nguyên nội dung chuyển khoản và chuyển đúng số tiền để hệ thống tự động kích hoạt gói ngay lập tức.
                              </Typography>

                              {[
                                { key: 'bank', label: 'Ngân hàng', value: activeOrder.bankCode, copyVal: activeOrder.bankCode },
                                { key: 'acc', label: 'Số tài khoản', value: activeOrder.accountNumber, copyVal: activeOrder.accountNumber },
                                { key: 'holder', label: 'Chủ tài khoản', value: activeOrder.accountName, copyVal: activeOrder.accountName },
                                { key: 'amount', label: 'Số tiền chính xác', value: formatVnd(activeOrder.amount, activeOrder.currency), copyVal: String(Math.round(activeOrder.amount)) },
                                { key: 'memo', label: 'Nội dung chuyển khoản', value: activeOrder.transferContent, copyVal: activeOrder.transferContent, highlight: true }
                              ].map(row => (
                                <Stack
                                  key={row.key}
                                  direction="row"
                                  sx={{
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    px: 1.5,
                                    py: 0.8,
                                    borderRadius: 1.5,
                                    bgcolor: row.highlight ? 'rgba(152,186,255,0.12)' : 'rgba(255,255,255,0.03)',
                                    border: row.highlight ? '1px solid rgba(152,186,255,0.45)' : '1px solid #263242'
                                  }}
                                >
                                  <Box sx={{ minWidth: 0 }}>
                                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{row.label}</Typography>
                                    <Typography
                                      variant="body2"
                                      sx={{
                                        fontWeight: row.highlight || row.key === 'amount' ? 800 : 600,
                                        color: row.highlight ? '#ffd700' : 'text.primary',
                                        fontFamily: row.key === 'acc' || row.key === 'memo' ? 'Consolas, monospace' : undefined
                                      }}
                                    >
                                      {row.value}
                                    </Typography>
                                  </Box>
                                  <Button
                                    size="small"
                                    variant="text"
                                    startIcon={copiedKey === row.key ? <Check fontSize="small" /> : <ContentCopy fontSize="small" />}
                                    onClick={() => void copyText(row.key, row.label, row.copyVal)}
                                  >
                                    {copiedKey === row.key ? 'Đã chép' : 'Sao chép'}
                                  </Button>
                                </Stack>
                              ))}

                              <Stack direction="row" sx={{ justifyContent: 'flex-end', gap: 1.5, pt: 0.5 }}>
                                <Button
                                  variant="outlined"
                                  color="inherit"
                                  disabled={cancelingOrder}
                                  onClick={() => void handleCancelOrder()}
                                >
                                  {cancelingOrder ? 'Đang hủy…' : 'Hủy đơn & chọn gói khác'}
                                </Button>
                              </Stack>
                            </Stack>
                          </Box>
                        )}
                      </Paper>
                    )}

                    {orders.length > 0 && (
                      <Box>
                        <Divider sx={{ mb: 1.5 }} />
                        <Typography variant="subtitle2" sx={{ mb: 1 }}>Lịch sử đơn thanh toán VietQR</Typography>
                        <Stack sx={{ gap: 0.8 }}>
                          {orders.slice(0, 5).map(ord => {
                            const meta = orderStatusLabel[ord.status];
                            return (
                              <Stack
                                key={ord.paymentCode}
                                direction="row"
                                sx={{
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  px: 1.2,
                                  py: 0.8,
                                  borderRadius: 1.5,
                                  bgcolor: 'rgba(255,255,255,0.03)',
                                  gap: 1
                                }}
                              >
                                <Typography variant="caption">
                                  <strong>{ord.paymentCode}</strong> · {ord.plan?.name || `Gói #${ord.planId}`} ({ord.billingCycle === 'YEARLY' ? 'Năm' : 'Tháng'}) · {formatVnd(ord.amount, ord.currency)}
                                </Typography>
                                <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                                  {ord.status === 'PENDING' && new Date(ord.expiresAt).getTime() > Date.now() && activeOrder?.paymentCode !== ord.paymentCode && (
                                    <Button size="small" onClick={() => setActiveOrder(ord)}>Mở QR</Button>
                                  )}
                                  <Chip size="small" label={meta.label} color={meta.color} variant="outlined" />
                                </Stack>
                              </Stack>
                            );
                          })}
                        </Stack>
                      </Box>
                    )}
                  </Stack>
                )}

                {paymentTab === 'manual' && (
                  <Stack sx={{ gap: 2 }}>
                    {pendingRequest && (
                      <Typography variant="body2" color="primary.main">
                        Bạn đang có yêu cầu nâng cấp lên gói <strong>{pendingRequest.requestedPlan?.name || `#${pendingRequest.requestedPlanId}`}</strong> ({pendingRequest.billingCycle === 'YEARLY' ? 'Theo năm' : 'Theo tháng'}) — Đang chờ quản trị viên duyệt.
                      </Typography>
                    )}
                    <TextField
                      label="Thông tin liên hệ / Ghi chú (SĐT, Zalo, nhu cầu sử dụng)"
                      placeholder="Ví dụ: Zalo 09xx.xxx.xxx — muốn nâng cấp gói Pro theo tháng"
                      value={contactNote}
                      onChange={e => setContactNote(e.target.value)}
                      fullWidth
                      size="small"
                      multiline
                      minRows={2}
                      disabled={submitting}
                    />
                    <Stack direction="row" sx={{ justifyContent: 'flex-end', gap: 1.5 }}>
                      <Button onClick={onClose} color="inherit">Đóng</Button>
                      <Button
                        variant="contained"
                        startIcon={<WorkspacePremium />}
                        disabled={submitting || !selectedPlanId}
                        onClick={() => void handleManualSubmit()}
                      >
                        {submitting ? 'Đang gửi…' : 'Gửi yêu cầu nâng cấp'}
                      </Button>
                    </Stack>

                    {requests.length > 0 && (
                      <Box>
                        <Divider sx={{ mb: 1.5 }} />
                        <Typography variant="subtitle2" sx={{ mb: 1 }}>Lịch sử yêu cầu thủ công gần đây</Typography>
                        <Stack sx={{ gap: 0.8 }}>
                          {requests.slice(0, 5).map(req => {
                            const meta = requestStatusLabel[req.status];
                            return (
                              <Stack key={req.id} direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', px: 1.2, py: 0.8, borderRadius: 1.5, bgcolor: 'rgba(255,255,255,0.03)' }}>
                                <Typography variant="caption">
                                  Gói <strong>{req.requestedPlan?.name || `#${req.requestedPlanId}`}</strong> ({req.billingCycle === 'YEARLY' ? 'Năm' : 'Tháng'})
                                  {req.adminNote ? ` · Ghi chú admin: ${req.adminNote}` : ''}
                                </Typography>
                                <Chip size="small" label={meta.label} color={meta.color} variant="outlined" />
                              </Stack>
                            );
                          })}
                        </Stack>
                      </Box>
                    )}
                  </Stack>
                )}
              </Box>
            </>
          )}
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
