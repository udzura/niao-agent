#include <mruby.h>
#include <task_hal.h>

#include <stdint.h>

void
mrb_hal_task_init(mrb_state *mrb)
{
  int i = 0;
  while (i < 4) {
    mrb->task.queues[i] = NULL;
    i++;
  }
  mrb->task.tick = 0;
  mrb->task.wakeup_tick = UINT32_MAX;
  mrb->task.switching = FALSE;
}

void
mrb_hal_task_final(mrb_state *mrb)
{
  (void)mrb;
}

void
mrb_task_enable_irq(void)
{
}

void
mrb_task_disable_irq(void)
{
}

void
mrb_hal_task_idle_cpu(mrb_state *mrb)
{
  (void)mrb;
}

void
mrb_hal_task_sleep_us(mrb_state *mrb, mrb_int usec)
{
  (void)mrb;
  (void)usec;
}
