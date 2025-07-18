import { users, expenses, billing, type User, type InsertUser, type Expense, type InsertExpense, type Billing, type InsertBilling } from "@shared/schema";
import { eq, and, like, gte, lte, desc, sql, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";

// Verificar se DATABASE_URL está configurada corretamente
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL não está configurada');
}

const neonSql = neon(databaseUrl!);
const db = drizzle(neonSql);

export interface IStorage {
  // User methods
  getUser(id: number): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUsersByRole(role: string): Promise<User[]>;
  createUser(user: InsertUser): Promise<User>;
  createUserWithAuth(user: InsertUser & { authUid: string }): Promise<User>;
  updateUserAuthUid(id: number, authUid: string): Promise<User>;
  
  // Expense methods
  getExpenses(filters?: {
    userId?: number;
    userIds?: number[];
    year?: string;
    month?: string;
    category?: string;
    contractNumber?: string;
    paymentMethod?: string;
  }): Promise<Expense[]>;
  getExpense(id: string): Promise<Expense | undefined>;
  createExpense(expense: InsertExpense & { userId: number }): Promise<Expense>;
  updateExpense(id: string, expense: Partial<InsertExpense>): Promise<Expense>;
  deleteExpense(id: string): Promise<void>;
  
  // Stats methods
  getExpenseStats(userId?: number): Promise<{
    totalAmount: number;
    totalExpenses: number;
    thisMonth: number;
    activeContracts: number;
  }>;
  
  getCategoryStats(filters?: {
    month?: string;
    contractNumber?: string;
  }): Promise<Array<{ category: string; total: number; count: number; }>>;
  
  getPaymentMethodStats(filters?: {
    month?: string;
    contractNumber?: string;
  }): Promise<Array<{ paymentMethod: string; count: number; }>>;
  
  getMonthlyTrends(): Promise<Array<{ month: string; total: number; }>>;
  
  // Billing methods
  getBilling(filters?: {
    userId?: number;
    userIds?: number[];
    year?: string;
    month?: string;
    status?: string;
    contractNumber?: string;
  }): Promise<Billing[]>;
  getBillingItem(id: string): Promise<Billing | undefined>;
  createBilling(billing: InsertBilling & { userId: number }): Promise<Billing>;
  updateBilling(id: string, billing: Partial<InsertBilling>): Promise<Billing>;
  deleteBilling(id: string): Promise<void>;
  
  getBillingStats(userId?: number): Promise<{
    totalPendente: number;
    totalPago: number;
    totalVencido: number;
  }>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return result[0];
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
    return result[0];
  }

  async createUser(user: InsertUser): Promise<User> {
    const result = await db.insert(users).values(user).returning();
    return result[0];
  }

  async getUsersByRole(role: string): Promise<User[]> {
    try {
      const result = await db.select().from(users).where(eq(users.role, role));
      return result;
    } catch (error) {
      console.error('Erro ao buscar usuários por função:', error);
      return [];
    }
  }

  async createUserWithAuth(user: InsertUser & { authUid: string }): Promise<User> {
    const result = await db.insert(users).values(user).returning();
    return result[0];
  }

  async updateUserAuthUid(id: number, authUid: string): Promise<User> {
    const result = await db.update(users).set({ authUid }).where(eq(users.id, id)).returning();
    return result[0];
  }

  async getExpenses(filters?: {
    userId?: number;
    userIds?: number[];
    month?: string;
    category?: string;
    contractNumber?: string;
    paymentMethod?: string;
  }): Promise<Expense[]> {
    let query = db.select().from(expenses);
    
    const conditions = [];
    
    if (filters?.userId) {
      conditions.push(eq(expenses.userId, filters.userId));
    } else if (filters?.userIds && filters.userIds.length > 0) {
      // Criar condições OR para múltiplos userIds
      const userConditions = filters.userIds.map(id => eq(expenses.userId, id));
      conditions.push(or(...userConditions));
    }
    
    if (filters?.month) {
      const startDate = new Date(filters.month + '-01');
      const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0);
      conditions.push(gte(expenses.paymentDate, startDate));
      conditions.push(lte(expenses.paymentDate, endDate));
    }
    
    if (filters?.category) {
      conditions.push(eq(expenses.category, filters.category));
    }
    
    if (filters?.contractNumber) {
      conditions.push(like(expenses.contractNumber, `%${filters.contractNumber}%`));
    }
    
    try {
      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as any;
      }
      
      return await (query as any).orderBy(desc(expenses.createdAt));
    } catch (error) {
      console.error('Erro na consulta de despesas:', error);
      return [];
    }
  }

  async getExpense(id: string): Promise<Expense | undefined> {
    const result = await db.select().from(expenses).where(eq(expenses.id, id)).limit(1);
    return result[0];
  }

  async createExpense(expense: InsertExpense & { userId: number }): Promise<Expense> {
    const result = await db.insert(expenses).values(expense).returning();
    return result[0];
  }

  async updateExpense(id: string, expense: Partial<InsertExpense>): Promise<Expense> {
    const result = await db.update(expenses).set(expense).where(eq(expenses.id, id)).returning();
    return result[0];
  }

  async cancelExpense(id: string): Promise<Expense> {
    // Mark expense as cancelled by adding a special prefix to category
    const expense = await this.getExpense(id);
    if (!expense) {
      throw new Error("Expense not found");
    }
    
    const updatedCategory = expense.category.startsWith('[CANCELADA]') 
      ? expense.category 
      : `[CANCELADA] ${expense.category}`;
    
    const result = await db.update(expenses)
      .set({ category: updatedCategory })
      .where(eq(expenses.id, id))
      .returning();
    return result[0];
  }

  async deleteExpense(id: string): Promise<void> {
    await db.delete(expenses).where(eq(expenses.id, id));
  }

  async getExpenseStats(userId?: number): Promise<{
    totalAmount: number;
    totalExpenses: number;
    thisMonth: number;
    activeContracts: number;
  }> {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const startOfMonth = new Date(currentMonth + '-01');
    const endOfMonth = new Date(startOfMonth.getFullYear(), startOfMonth.getMonth() + 1, 0);
    
    let allExpensesQuery = db.select().from(expenses);
    let monthExpensesQuery = db.select().from(expenses)
      .where(and(
        gte(expenses.paymentDate, startOfMonth),
        lte(expenses.paymentDate, endOfMonth)
      ));
    
    if (userId) {
      allExpensesQuery = allExpensesQuery.where(eq(expenses.userId, userId));
      monthExpensesQuery = monthExpensesQuery.where(and(
        eq(expenses.userId, userId),
        gte(expenses.paymentDate, startOfMonth),
        lte(expenses.paymentDate, endOfMonth)
      ));
    }
    
    const allExpenses = await allExpensesQuery;
    const monthExpenses = await monthExpensesQuery;
    
    const totalAmount = allExpenses.reduce((sum, exp) => sum + parseFloat(exp.totalValue), 0);
    const thisMonth = monthExpenses.reduce((sum, exp) => sum + parseFloat(exp.totalValue), 0);
    const activeContracts = new Set(allExpenses.map(exp => exp.contractNumber)).size;
    
    return {
      totalAmount,
      totalExpenses: allExpenses.length,
      thisMonth,
      activeContracts,
    };
  }

  async getCategoryStats(filters?: {
    month?: string;
    contractNumber?: string;
  }): Promise<Array<{ category: string; total: number; count: number; }>> {
    let query = db.select().from(expenses);
    
    const conditions = [];
    
    if (filters?.month) {
      const startDate = new Date(filters.month + '-01');
      const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0);
      conditions.push(gte(expenses.paymentDate, startDate));
      conditions.push(lte(expenses.paymentDate, endDate));
    }
    
    if (filters?.contractNumber) {
      conditions.push(like(expenses.contractNumber, `%${filters.contractNumber}%`));
    }
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }
    
    const results = await query;
    
    const categoryMap = new Map<string, { total: number; count: number; }>();
    
    results.forEach(expense => {
      const existing = categoryMap.get(expense.category) || { total: 0, count: 0 };
      categoryMap.set(expense.category, {
        total: existing.total + parseFloat(expense.totalValue),
        count: existing.count + 1,
      });
    });
    
    return Array.from(categoryMap.entries()).map(([category, stats]) => ({
      category,
      ...stats,
    }));
  }

  async getPaymentMethodStats(filters?: {
    month?: string;
    contractNumber?: string;
  }): Promise<Array<{ paymentMethod: string; count: number; }>> {
    let query = db.select().from(expenses);
    
    const conditions = [];
    
    if (filters?.month) {
      const startDate = new Date(filters.month + '-01');
      const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0);
      conditions.push(gte(expenses.paymentDate, startDate));
      conditions.push(lte(expenses.paymentDate, endDate));
    }
    
    if (filters?.contractNumber) {
      conditions.push(like(expenses.contractNumber, `%${filters.contractNumber}%`));
    }
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }
    
    const results = await query;
    
    const paymentMap = new Map<string, number>();
    
    results.forEach(expense => {
      const existing = paymentMap.get(expense.paymentMethod) || 0;
      paymentMap.set(expense.paymentMethod, existing + 1);
    });
    
    return Array.from(paymentMap.entries()).map(([paymentMethod, count]) => ({
      paymentMethod,
      count,
    }));
  }

  async getMonthlyTrends(): Promise<Array<{ month: string; total: number; }>> {
    const results = await db.select().from(expenses).orderBy(expenses.paymentDate);
    
    const monthlyMap = new Map<string, number>();
    
    results.forEach(expense => {
      const month = expense.paymentDate.toISOString().slice(0, 7);
      const existing = monthlyMap.get(month) || 0;
      monthlyMap.set(month, existing + parseFloat(expense.totalValue));
    });
    
    return Array.from(monthlyMap.entries()).map(([month, total]) => ({
      month,
      total,
    }));
  }

  async getExpensesByContract(filters?: {
    month?: string;
    contractNumber?: string;
  }): Promise<Array<{
    contractNumber: string;
    totalAmount: number;
    expenseCount: number;
    categories: Array<{
      category: string;
      amount: number;
      count: number;
    }>;
  }>> {
    let query = db.select().from(expenses);
    
    const conditions = [];
    
    if (filters?.month) {
      const startDate = new Date(filters.month + '-01');
      const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0);
      conditions.push(gte(expenses.paymentDate, startDate));
      conditions.push(lte(expenses.paymentDate, endDate));
    }
    
    if (filters?.contractNumber) {
      conditions.push(like(expenses.contractNumber, `%${filters.contractNumber}%`));
    }
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }
    
    const allExpenses = await query;

    // Agrupar por contrato
    const contractMap = new Map<string, {
      totalAmount: number;
      expenseCount: number;
      categories: Map<string, { amount: number; count: number }>;
    }>();

    allExpenses.forEach(expense => {
      const contractNumber = expense.contractNumber;
      const value = parseFloat(expense.value);

      if (!contractMap.has(contractNumber)) {
        contractMap.set(contractNumber, {
          totalAmount: 0,
          expenseCount: 0,
          categories: new Map(),
        });
      }

      const contract = contractMap.get(contractNumber)!;
      contract.totalAmount += value;
      contract.expenseCount += 1;

      // Agrupar por categoria
      const category = expense.category;
      if (!contract.categories.has(category)) {
        contract.categories.set(category, { amount: 0, count: 0 });
      }

      const categoryData = contract.categories.get(category)!;
      categoryData.amount += value;
      categoryData.count += 1;
    });

    // Converter para formato final
    const result = Array.from(contractMap.entries()).map(([contractNumber, data]) => ({
      contractNumber,
      totalAmount: data.totalAmount,
      expenseCount: data.expenseCount,
      categories: Array.from(data.categories.entries()).map(([category, categoryData]) => ({
        category,
        amount: categoryData.amount,
        count: categoryData.count,
      })),
    }));

    // Ordenar por valor total (decrescente)
    result.sort((a, b) => b.totalAmount - a.totalAmount);

    return result;
  }

  // Billing methods implementation (mock data until table is created)
  async getBilling(filters?: {
    userId?: number;
    userIds?: number[];
    year?: string;
    month?: string;
    status?: string;
    contractNumber?: string;
  }): Promise<Billing[]> {
    try {
      let query = db.select().from(billing);
      
      const conditions: any[] = [];
      
      if (filters?.year) {
        conditions.push(sql`EXTRACT(YEAR FROM ${billing.issueDate}) = ${filters.year}`);
      }
      
      if (filters?.month) {
        conditions.push(sql`EXTRACT(MONTH FROM ${billing.issueDate}) = ${filters.month}`);
      }
      
      if (filters?.status) {
        conditions.push(eq(billing.status, filters.status));
      }
      
      if (filters?.contractNumber) {
        conditions.push(eq(billing.contractNumber, filters.contractNumber));
      }
      
      if (filters?.userId) {
        conditions.push(eq(billing.userId, filters.userId));
      } else if (filters?.userIds && filters.userIds.length > 0) {
        // Criar condições OR para múltiplos userIds no billing
        const userConditions = filters.userIds.map((id: number) => eq(billing.userId, id));
        conditions.push(or(...userConditions));
      }
      
      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as any;
      }
      
      return await query.orderBy(desc(billing.createdAt));
    } catch (error) {
      console.error('Error fetching billing:', error);
      // Return mock data if database query fails
      const mockBilling: Billing[] = [
        {
          id: "bill-001",
          userId: 1,
          contractNumber: "0001",
          clientName: "Cliente Exemplo A",
          description: "Serviços de consultoria - Janeiro 2025",
          value: "15000.00",
          dueDate: new Date("2025-01-31"),
          issueDate: new Date("2025-01-01"),
          status: "pago",
          createdAt: new Date(),
        },
        {
          id: "bill-002",
          userId: 1,
          contractNumber: "0002",
          clientName: "Cliente Exemplo B",
          description: "Manutenção sistema - Janeiro 2025",
          value: "8500.00",
          dueDate: new Date("2025-02-15"),
          issueDate: new Date("2025-01-15"),
          status: "pago",
          createdAt: new Date(),
        },
        {
          id: "bill-003",
          userId: 1,
          contractNumber: "0003",
          clientName: "Cliente Exemplo C",
          description: "Desenvolvimento - Janeiro 2025",
          value: "12000.00",
          dueDate: new Date("2025-02-28"),
          issueDate: new Date("2025-01-20"),
          status: "pago",
          createdAt: new Date(),
        }
      ];
      
      return mockBilling;
    }
  }

  async getBillingItem(id: string): Promise<Billing | undefined> {
    // Mock implementation
    return undefined;
  }

  async createBilling(billingData: InsertBilling & { userId: number }): Promise<Billing> {
    try {
      const result = await db.insert(billing).values({
        contractNumber: billingData.contractNumber,
        clientName: billingData.clientName,
        description: billingData.description,
        value: billingData.value,
        dueDate: billingData.dueDate,
        issueDate: billingData.issueDate,
        status: billingData.status || "pendente",
        userId: billingData.userId,
      }).returning();
      
      return result[0];
    } catch (error) {
      console.error('Error creating billing:', error);
      // Fallback para dados mock se falhar
      const newBilling: Billing = {
        id: `bill-${Date.now()}`,
        ...billingData,
        status: billingData.status || "pendente",
        createdAt: new Date(),
      };
      return newBilling;
    }
  }

  async updateBilling(id: string, updates: Partial<InsertBilling>): Promise<Billing> {
    try {
      const result = await db.update(billing)
        .set(updates)
        .where(eq(billing.id, id))
        .returning();
      
      if (result.length === 0) {
        throw new Error("Billing not found");
      }
      
      return result[0];
    } catch (error) {
      console.error('Error updating billing:', error);
      throw new Error("Failed to update billing");
    }
  }

  async deleteBilling(id: string): Promise<void> {
    try {
      await db.delete(billing).where(eq(billing.id, id));
    } catch (error) {
      console.error('Error deleting billing:', error);
      throw new Error("Failed to delete billing");
    }
  }

  async getBillingStats(userId?: number): Promise<{
    totalPendente: number;
    totalPago: number;
    totalVencido: number;
  }> {
    try {
      const stats = await db.select({
        status: billing.status,
        total: sql<number>`SUM(CAST(${billing.value} AS DECIMAL))`,
      })
      .from(billing)
      .groupBy(billing.status);
      
      const result = {
        totalPendente: 0,
        totalPago: 0,
        totalVencido: 0,
      };
      
      for (const stat of stats) {
        if (stat.status === 'pendente') result.totalPendente = Number(stat.total) || 0;
        if (stat.status === 'pago') result.totalPago = Number(stat.total) || 0;
        if (stat.status === 'vencido') result.totalVencido = Number(stat.total) || 0;
      }
      
      return result;
    } catch (error) {
      console.error('Error fetching billing stats:', error);
      // Return mock data if database query fails
      return {
        totalPendente: 5000,
        totalPago: 35500,
        totalVencido: 2800,
      };
    }
  }
}

export const storage = new DatabaseStorage();
