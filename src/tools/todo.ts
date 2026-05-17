import z from "zod";


type PlanStatus = "pending" | "in_progress" | "completed";

type PlanItem = {
  content: string;      
  status: PlanStatus;   
  activeForm: string;   
};


type PlanningState = {
  items: PlanItem[];            
  roundsSinceUpdate: number;     
};


// 判断传入的状态字符串是否属于允许的计划状态
function isPlanStatus(value: string): value is PlanStatus {
  return (
    value === "pending" || value === "in_progress" || value === "completed"
  );
}

const PLAN_REMINDER_INTERVAL = 3;


export class TodoManager {
 
  // 保存当前会话计划及自上次更新后的轮次数
  state: PlanningState = { items: [], roundsSinceUpdate: 0 };

  // 更新会话计划，校验条目并重置提醒计数
  update(items: PlanItem[]): string {
    if (!Array.isArray(items)) throw new Error("items must be an array");

    if (items.length > 12)
      throw new Error("Keep the session plan short (max 12 items)");

    const normalized: PlanItem[] = [];
    let inProgressCount = 0;

    items.forEach((item, index) => {
      const content = String(item.content).trim();
      const status = String(item.status ?? "pending")
        .trim()
        .toLowerCase();
      const activeForm = String(item.activeForm).trim();

      if (!content) throw new Error(`Item ${index}: content required`);
      if (!isPlanStatus(status))
        throw new Error(`Item ${index}: invalid status '${status}'`);

      status === "in_progress" && inProgressCount++;

      normalized.push({ content, status, activeForm });
    });

    if (inProgressCount > 1)
      throw new Error("Only one plan item can be in_progress");

    this.state.items = normalized;
    this.state.roundsSinceUpdate = 0;
    return this.render();
  }


  // 记录一次未更新计划的回合，用于后续提醒
  noteRoundWithoutUpdate(): void {
    this.state.roundsSinceUpdate++;
  }


  // 当回合数达到阈值时返回提醒，否则返回空
  reminder(): string | null {
    if (this.state.items.length === 0) return null;
    if (this.state.roundsSinceUpdate < PLAN_REMINDER_INTERVAL) return null;

    return "<reminder>Refresh your current plan before continuing.</reminder>";
  }


  // 将当前计划格式化为可展示的文本
  render(): string {
    if (this.state.items.length === 0) return "No session plan yet.";

    const lines = this.state.items.map((item) => {
      const marker = {
        pending: "[🟤]",
        in_progress: "[🟢]",
        completed: "[✔️]",
      }[item.status];

      let line = `${marker} ${item.content}`;
      if (item.status === "in_progress" && item.activeForm) {
        line += ` (${item.activeForm})`;
      }
      return line;
    });

    const completed = this.state.items.filter(
      (item) => item.status === "completed",
    ).length;
    lines.push(`\n(${completed}/${this.state.items.length} completed)`);

    return lines.join("\n");
  }
}


export const TODO = new TodoManager();


export const TodoArgsSchema = z.object({
  items: z
    .array(
      z.object({
        content: z.string().trim().min(1, "content required"),
        status: z
          .enum(["pending", "in_progress", "completed"])
          .default("pending"),
        activeForm: z.string().trim().default(""),
      }),
    )
    .max(12, "Keep the session plan short (max 12 items)")
    .refine(
      (items) =>
        items.filter((item) => item.status === "in_progress").length <= 1,
      "Only one plan item can be in_progress",
    ),
});


export const todo = TODO.update.bind(TODO);
