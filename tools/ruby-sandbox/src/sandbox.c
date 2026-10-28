#include <picoruby.h>
#include <mruby/proc.h>
#include <mruby/string.h>
#include <mruby/variable.h>
#include <mruby/error.h>
#include <mrc_utils.h>
#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#undef mrb_irep

static unsigned count, reason;
static unsigned output_bytes, result_len;
EMSCRIPTEN_KEEPALIVE unsigned niao_result_len(void) { return result_len; }
static void stop(unsigned code) { reason = code; __builtin_trap(); }
EMSCRIPTEN_KEEPALIVE unsigned niao_reason(void) { return reason; }
EMSCRIPTEN_KEEPALIVE unsigned niao_count(void) { return count; }
static void tick(mrb_state *mrb, const mrb_irep *irep, const mrb_code *pc, mrb_value *regs) {
  (void)mrb; (void)irep; (void)pc; (void)regs;
  if (++count > 200000) stop(1);
}
EM_JS(void, log_bytes, (const char *ptr, int len), { Module.niaoLog(HEAPU8.subarray(ptr, ptr + len)); });
static mrb_value output(mrb_state *mrb, mrb_value self) {
  mrb_value *args; mrb_int argc; mrb_get_args(mrb, "*", &args, &argc);
  for (mrb_int i = 0; i < argc; i++) {
    mrb_value s = mrb_obj_as_string(mrb, args[i]);
    size_t len = RSTRING_LEN(s);
    if (len > 4096 || output_bytes + len + 1 > 4096) stop(2);
    output_bytes += len + 1;
    log_bytes(RSTRING_PTR(s), len); log_bytes("\n", 1);
  }
  return mrb_nil_value();
}
EM_JS(void, phase, (int n), { if (Module.niaoPhase) Module.niaoPhase(n); });
static mrb_value execute(mrb_state *mrb, void *data) {
  const uint8_t *source = data;
  mrc_ccontext *cc = mrc_ccontext_new(mrb);
  cc->capture_errors = FALSE; // Compiler uses this flag to report failure, not to request capture.
  mrc_irep *irep = mrc_load_string_cxt(cc, &source, strlen((const char *)source));
  if (!irep) { mrc_ccontext_free(cc); reason = 3; return mrb_nil_value(); }
  mrc_resolve_intern(cc, irep);
  struct RProc *proc = mrb_proc_new(mrb, irep);
  mrc_ccontext_free(cc);
  phase(2);
  mrb_value value = mrb_top_run(mrb, proc, mrb_top_self(mrb), 0);
  phase(3);
  if (mrb->exc) { reason = 4; return mrb_nil_value(); }
  // Explicit result: Ruby string, number, bool or nil. Never invoke arbitrary inspect/to_json.
  if (mrb_string_p(value)) return value;
  if (mrb_nil_p(value)) return mrb_str_new_lit(mrb, "null");
  if (mrb_true_p(value)) return mrb_str_new_lit(mrb, "true");
  if (mrb_false_p(value)) return mrb_str_new_lit(mrb, "false");
  if (mrb_integer_p(value) || mrb_float_p(value)) return mrb_obj_as_string(mrb, value);
  reason = 5; return mrb_nil_value();
}
// One call per Wasm instance, including successful calls. The host discards all memory.
EMSCRIPTEN_KEEPALIVE const char *niao_eval(const char *source) {
  if (strlen(source) > 8192) { reason = 6; return NULL; }
  phase(0);
  mrb_state *mrb = mrb_open();
  if (!mrb || mrb->exc) { reason = 7; return NULL; }
  mrb_define_method(mrb, mrb->kernel_module, "puts", output, MRB_ARGS_ANY());
  mrb_define_method(mrb, mrb->kernel_module, "print", output, MRB_ARGS_ANY());
  mrb_define_method(mrb, mrb->kernel_module, "p", output, MRB_ARGS_ANY());
  const char *disabled[] = {"require", "load", "eval", "system", "exec", "spawn", "exit", "abort", "sleep"};
  for (unsigned i = 0; i < sizeof(disabled)/sizeof(disabled[0]); i++) {
    mrb_undef_method(mrb, mrb->kernel_module, disabled[i]);
    mrb_undef_class_method(mrb, mrb->kernel_module, disabled[i]);
  }
  mrb->code_fetch_hook = tick;
  phase(1);
  mrb_bool failed = FALSE;
  mrb_value result = mrb_protect_error(mrb, execute, (void *)source, &failed);
  if (failed || mrb->exc) { reason = 4; return NULL; }
  if (reason) return NULL;
  if (RSTRING_LEN(result) > 8192) stop(2);
  result_len = RSTRING_LEN(result);
  return RSTRING_PTR(result);
}
void mrb_niao_ruby_sandbox_gem_init(mrb_state *mrb) { (void)mrb; }
void mrb_niao_ruby_sandbox_gem_final(mrb_state *mrb) { (void)mrb; }
