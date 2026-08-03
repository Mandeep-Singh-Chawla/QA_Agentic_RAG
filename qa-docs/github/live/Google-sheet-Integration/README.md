# GitHub — Mandeep-Singh-Chawla/Google-sheet-Integration

Source: https://github.com/Mandeep-Singh-Chawla/Google-sheet-Integration/blob/main/README.md

Utility in Java to read data from Google sheet or write data on it, which can be easily implemented in QA Automation Framework. 
Authorization mechanism used here is OAuth 2.0

**Steps to Implement:-**


1) Create client_secret_*.json as per the steps mentioned in ppt - https://docs.google.com/presentation/d/1XQo34TYKp376WBtnSbN6SPQT19Ht0IqvRWOSxnUy2ok/edit#slide=id.p
2) Copy details from client_secret_*.json created in above step and paste it in client_secret.json file of framework
3) Edit GSheetTest field in Constant.java with your Gsheet link
4) Edit CalculationSheetRange field in Constant.java as per tab name and coloumn details of your Gsheet
5) When you run script 1st time , it will ask for your GAccount to be used 
6) Make sure GAccount used in above step have read/write access for GSheet(used in point 3) and app access also(slide 11 of ppt)

