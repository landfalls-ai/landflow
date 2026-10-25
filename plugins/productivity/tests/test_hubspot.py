"""HubSpot node against a fake HubSpot CRM API."""

from __future__ import annotations

import unittest

from _support import TOKEN, FakeApi, execute, jsons, make_plugin, metric_value

CONTACTS = "/crm/v3/objects/contacts"


def contact(n: int, **props) -> dict:
    return {"id": str(n), "properties": {"email": f"c{n}@example.com", "hs_object_id": str(n), **props},
            "createdAt": "2026-10-25T10:00:00Z", "archived": False}


class HubSpotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = FakeApi().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.api.__exit__()

    def setUp(self):
        self.api.reset()
        self.plugin = make_plugin()
        self.creds = {"hubspotAppToken": {"appToken": TOKEN, "baseUrl": self.api.url}}

    def run_node(self, parameters, **kwargs):
        return execute(self.plugin, "hubspot", parameters, credentials=self.creds, **kwargs)

    def test_credential_test(self):
        self.api.route("GET", CONTACTS, lambda r: {"results": []} if r["headers"]["authorization"] == f"Bearer {TOKEN}" else
                       (401, {"status": "error", "message": "Authentication credentials not found.", "category": "INVALID_AUTHENTICATION"}))
        self.assertEqual(self.plugin.test_credentials("hubspotAppToken", {"appToken": TOKEN, "baseUrl": self.api.url}),
                         {"ok": True, "message": "HubSpot accepted the token"})
        self.assertEqual(self.api.requests[0]["query"], {"limit": ["1"]})
        self.assertEqual(self.plugin.test_credentials("hubspotAppToken", {"appToken": "pat-wrong", "baseUrl": self.api.url}),
                         {"ok": False, "message": "HubSpot API error (HTTP 401): Authentication credentials not found."})

    def test_upsert_updates_existing_contact(self):
        self.api.route("POST", f"{CONTACTS}/search", {"total": 1, "results": [contact(42)]})
        self.api.route("PATCH", f"{CONTACTS}/42", lambda r: contact(42, **r["json"]["properties"]))
        response = self.run_node({"resource": "contact", "operation": "upsert", "email": "c42@example.com",
                                  "additionalFields": {"firstName": "Ada", "companyName": "Analytical"},
                                  "customPropertiesUi": {"customPropertiesValues": [{"property": "favorite_color", "value": "teal"}]}})
        search = self.api.requests[0]["json"]
        self.assertEqual(search["filterGroups"], [{"filters": [{"propertyName": "email", "operator": "EQ", "value": "c42@example.com"}]}])
        self.assertEqual(self.api.requests[1]["json"], {"properties": {"email": "c42@example.com", "firstname": "Ada",
                                                                       "company": "Analytical", "favorite_color": "teal"}})
        self.assertEqual(jsons(response)[0], {"id": "42", "email": "c42@example.com", "hs_object_id": "42", "firstname": "Ada",
                                              "company": "Analytical", "favorite_color": "teal"})
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.records_written", service="hubspot", operation="upsert"), 1)

    def test_upsert_creates_missing_contact(self):
        self.api.route("POST", f"{CONTACTS}/search", {"total": 0, "results": []})
        self.api.route("POST", CONTACTS, lambda r: contact(7, **r["json"]["properties"]))
        response = self.run_node({"resource": "contact", "operation": "upsert", "email": "new@example.com", "simplify": False})
        self.assertEqual(self.api.calls("POST", CONTACTS)[0]["json"], {"properties": {"email": "new@example.com"}})
        self.assertEqual(jsons(response)[0]["properties"]["email"], "new@example.com")

    def test_get_contact(self):
        self.api.route("GET", f"{CONTACTS}/5", contact(5, firstname="Bo"))
        response = self.run_node({"resource": "contact", "operation": "get", "contactId": "5", "options": {"properties": "email, firstname"}})
        self.assertEqual(self.api.requests[0]["query"], {"properties": ["email,firstname"]})
        self.assertEqual(jsons(response), [{"id": "5", "email": "c5@example.com", "hs_object_id": "5", "firstname": "Bo"}])

    def test_search_pages_with_after(self):
        def search(r):
            if r["json"].get("after") == "2":
                return {"total": 3, "results": [contact(3)]}
            return {"total": 3, "results": [contact(1), contact(2)], "paging": {"next": {"after": "2"}}}

        self.api.route("POST", f"{CONTACTS}/search", search)
        response = self.run_node({"resource": "contact", "operation": "search", "returnAll": True,
                                  "filtersUi": {"filterValues": [{"propertyName": "lifecyclestage", "operator": "EQ", "value": "lead"},
                                                                 {"propertyName": "phone", "operator": "HAS_PROPERTY", "value": "ignored"}]},
                                  "options": {"properties": "email", "sortBy": "createdate", "direction": "ASCENDING"}})
        self.assertEqual([j["id"] for j in jsons(response)], ["1", "2", "3"])
        first, second = self.api.requests
        self.assertEqual(first["json"], {
            "filterGroups": [{"filters": [{"propertyName": "lifecyclestage", "operator": "EQ", "value": "lead"},
                                          {"propertyName": "phone", "operator": "HAS_PROPERTY"}]}],
            "properties": ["email"], "sorts": [{"propertyName": "createdate", "direction": "ASCENDING"}], "limit": 200,
        })
        self.assertEqual(second["json"]["after"], "2")

    def test_search_limit(self):
        self.api.route("POST", f"{CONTACTS}/search", {"results": [contact(1), contact(2)], "paging": {"next": {"after": "2"}}})
        response = self.run_node({"resource": "contact", "operation": "search", "query": "ada", "limit": 2})
        self.assertEqual(len(jsons(response)), 2)
        self.assertEqual(len(self.api.requests), 1)
        self.assertEqual((self.api.requests[0]["json"]["limit"], self.api.requests[0]["json"]["query"]), (2, "ada"))

    def test_create_deal_with_contacts(self):
        self.api.route("POST", "/crm/v3/objects/deals", lambda r: {"id": "900", "properties": r["json"]["properties"]})
        response = self.run_node({"resource": "deal", "operation": "create", "dealName": "Big deal", "pipeline": "default",
                                  "stage": "contractsent", "dealFields": {"amount": "1500", "closeDate": "2026-12-31", "associatedContactIds": "1, 2"}})
        body = self.api.requests[0]["json"]
        self.assertEqual(body["properties"], {"dealname": "Big deal", "dealstage": "contractsent", "pipeline": "default",
                                              "amount": "1500", "closedate": "2026-12-31"})
        self.assertEqual(body["associations"], [
            {"to": {"id": c}, "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 3}]} for c in ("1", "2")])
        self.assertEqual(jsons(response)[0]["id"], "900")
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.records_written", service="hubspot", operation="create"), 1)

    def test_error_mapping(self):
        self.api.route("POST", "/crm/v3/objects/deals", (400, {"status": "error", "message": "Property values were not valid",
                                                                "category": "VALIDATION_ERROR", "correlationId": "abc"}))
        response = self.run_node({"resource": "deal", "operation": "create", "dealName": "x", "stage": "bogus"})
        self.assertEqual(response["error"]["message"], "HubSpot API error (HTTP 400): Property values were not valid")
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.api_errors", service="hubspot", status_class="4xx"), 1)

    def test_load_pipelines_and_stages(self):
        self.api.route("GET", "/crm/v3/pipelines/deals", {"results": [
            {"id": "p2", "label": "Renewals", "displayOrder": 1, "stages": [{"id": "r1", "label": "Open", "displayOrder": 0}]},
            {"id": "default", "label": "Sales Pipeline", "displayOrder": 0, "stages": [
                {"id": "closedwon", "label": "Closed Won", "displayOrder": 5}, {"id": "appointmentscheduled", "label": "Appointment", "displayOrder": 0}]},
        ]})
        self.assertEqual([o["value"] for o in self.plugin.load_options("hubspot", "getDealPipelines", {}, self.creds)], ["default", "p2"])
        self.assertEqual(self.plugin.load_options("hubspot", "getDealStages", {"pipeline": "default"}, self.creds),
                         [{"name": "Appointment", "value": "appointmentscheduled"}, {"name": "Closed Won", "value": "closedwon"}])
        self.assertEqual(len(self.plugin.load_options("hubspot", "getDealStages", {}, self.creds)), 3)


if __name__ == "__main__":
    unittest.main()
