/**
 * The curated catalog (spec 1.3): the services the plugin offers by name. Written by hand from the spec; the service names, entity
 * sets and key names are NOT verified against SAP's Business Accelerator Hub (phase 0 was skipped, it needs an SAP account), and
 * the communication scenario ids are left out where the spec could not confirm them. A tenant's real `$metadata` always wins: the
 * node's entity-set and property pickers read it, and a custom service path reaches anything else.
 */
import type { ODataVersion } from './odata/query';

export interface CatalogEntitySet {
  name: string;
  keys: string[];
  /** Properties that change when the record does, best first; empty: not offered for polling. */
  changeTimestamps: string[];
}

export interface CatalogService {
  id: string;
  title: string;
  version: ODataVersion;
  /** Path below the base URL, V2 pattern `/sap/opu/odata/sap/<SERVICE>` (UNVERIFIED for Public Edition). */
  path: string;
  /** The communication scenario an admin must enable; only given where the spec names one. */
  scenario?: string;
  entitySets: CatalogEntitySet[];
}

const v2 = (id: string) => `/sap/opu/odata/sap/${id}`;

export const CATALOG: CatalogService[] = [
  {
    id: 'API_BUSINESS_PARTNER',
    title: 'Business Partner',
    version: 'v2',
    path: v2('API_BUSINESS_PARTNER'),
    scenario: 'SAP_COM_0008',
    entitySets: [
      { name: 'A_BusinessPartner', keys: ['BusinessPartner'], changeTimestamps: ['LastChangeDate'] },
      { name: 'A_Customer', keys: ['Customer'], changeTimestamps: [] },
      { name: 'A_Supplier', keys: ['Supplier'], changeTimestamps: [] },
    ],
  },
  {
    id: 'API_SALES_ORDER_SRV',
    title: 'Sales Order',
    version: 'v2',
    path: v2('API_SALES_ORDER_SRV'),
    entitySets: [
      { name: 'A_SalesOrder', keys: ['SalesOrder'], changeTimestamps: ['LastChangeDateTime', 'LastChangeDate'] },
      { name: 'A_SalesOrderItem', keys: ['SalesOrder', 'SalesOrderItem'], changeTimestamps: [] },
    ],
  },
  {
    id: 'API_PURCHASEORDER_PROCESS_SRV',
    title: 'Purchase Order',
    version: 'v2',
    path: v2('API_PURCHASEORDER_PROCESS_SRV'),
    entitySets: [
      { name: 'A_PurchaseOrder', keys: ['PurchaseOrder'], changeTimestamps: ['LastChangeDateTime'] },
      { name: 'A_PurchaseOrderItem', keys: ['PurchaseOrder', 'PurchaseOrderItem'], changeTimestamps: [] },
    ],
  },
  {
    id: 'API_PRODUCT_SRV',
    title: 'Product',
    version: 'v2',
    path: v2('API_PRODUCT_SRV'),
    entitySets: [{ name: 'A_Product', keys: ['Product'], changeTimestamps: ['LastChangeDateTime', 'LastChangeDate'] }],
  },
  {
    id: 'API_SUPPLIERINVOICE_PROCESS_SRV',
    title: 'Supplier Invoice',
    version: 'v2',
    path: v2('API_SUPPLIERINVOICE_PROCESS_SRV'),
    entitySets: [{ name: 'A_SupplierInvoice', keys: ['SupplierInvoice', 'FiscalYear'], changeTimestamps: [] }],
  },
];

export const CUSTOM_SERVICE = 'custom';

export const serviceById = (id: string) => CATALOG.find((s) => s.id === id);

/** A friendly node over one catalog service (spec 3.2, item 2): the same engine with a fixed service and a short operation list. */
export interface Preset {
  /** Node name and display name. */
  name: string;
  displayName: string;
  description: string;
  service: string;
  defaultEntitySet: string;
  operations: Array<'get' | 'list' | 'create' | 'update' | 'delete'>;
  keywords: string[];
  /** Extra list filters the node offers as plain fields (ANDed into `$filter`). */
  filters?: Array<{ name: string; displayName: string; property: string; kind: 'string' | 'dateFrom' | 'dateTo'; description: string }>;
  /** Help for the body of a create or update. */
  bodyHint?: string;
}

export const PRESETS: Preset[] = [
  {
    name: 'sapBusinessPartner',
    displayName: 'SAP Business Partner',
    description: 'Get, list, create and update business partners, customers and suppliers in SAP S/4HANA Cloud',
    service: 'API_BUSINESS_PARTNER',
    defaultEntitySet: 'A_BusinessPartner',
    operations: ['get', 'list', 'create', 'update'],
    keywords: ['sap', 'business partner', 'customer', 'supplier', 'bp'],
    filters: [{ name: 'searchTerm', displayName: 'Search Term', property: 'SearchTerm1', kind: 'string', description: 'Business partners whose search term 1 equals this (SAP searches are exact here)' }],
    bodyHint: '{"BusinessPartnerCategory": "2", "OrganizationBPName1": "Acme"}',
  },
  {
    name: 'sapSalesOrder',
    displayName: 'SAP Sales Order',
    description: 'Get, list (by customer and date), create (with items) and update sales orders in SAP S/4HANA Cloud',
    service: 'API_SALES_ORDER_SRV',
    defaultEntitySet: 'A_SalesOrder',
    operations: ['get', 'list', 'create', 'update'],
    keywords: ['sap', 'sales order', 'order', 'sd'],
    filters: [
      { name: 'customer', displayName: 'Sold-To Party', property: 'SoldToParty', kind: 'string', description: 'Only orders of this customer number' },
      { name: 'createdFrom', displayName: 'Created From', property: 'CreationDate', kind: 'dateFrom', description: 'Only orders created on or after this date (ISO 8601)' },
      { name: 'createdTo', displayName: 'Created To', property: 'CreationDate', kind: 'dateTo', description: 'Only orders created on or before this date (ISO 8601)' },
    ],
    bodyHint: '{"SalesOrderType": "OR", "SoldToParty": "10100001", "to_Item": [{"Material": "TG11", "RequestedQuantity": "1"}]}',
  },
  {
    name: 'sapPurchaseOrder',
    displayName: 'SAP Purchase Order',
    description: 'Get, list and create purchase orders in SAP S/4HANA Cloud',
    service: 'API_PURCHASEORDER_PROCESS_SRV',
    defaultEntitySet: 'A_PurchaseOrder',
    operations: ['get', 'list', 'create'],
    keywords: ['sap', 'purchase order', 'po', 'procurement'],
    filters: [{ name: 'supplier', displayName: 'Supplier', property: 'Supplier', kind: 'string', description: 'Only orders of this supplier number' }],
    bodyHint: '{"CompanyCode": "1010", "PurchasingOrganization": "1010", "Supplier": "10300001", "to_PurchaseOrderItem": [{"Material": "TG11", "OrderQuantity": "1"}]}',
  },
  {
    name: 'sapProduct',
    displayName: 'SAP Product',
    description: 'Get and list products (materials) in SAP S/4HANA Cloud',
    service: 'API_PRODUCT_SRV',
    defaultEntitySet: 'A_Product',
    operations: ['get', 'list'],
    keywords: ['sap', 'product', 'material', 'article'],
  },
  {
    name: 'sapSupplierInvoice',
    displayName: 'SAP Supplier Invoice',
    description: 'Get and list supplier invoices in SAP S/4HANA Cloud',
    service: 'API_SUPPLIERINVOICE_PROCESS_SRV',
    defaultEntitySet: 'A_SupplierInvoice',
    operations: ['get', 'list'],
    keywords: ['sap', 'supplier invoice', 'invoice', 'accounts payable'],
    filters: [{ name: 'supplier', displayName: 'Invoicing Party', property: 'InvoicingParty', kind: 'string', description: 'Only invoices of this supplier number' }],
  },
];
