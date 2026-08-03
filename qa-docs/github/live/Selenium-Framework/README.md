# GitHub — Mandeep-Singh-Chawla/Selenium-Framework

Source: https://github.com/Mandeep-Singh-Chawla/Selenium-Framework/blob/main/README.md

**Selenium Framework** using TestNG and Java

**Some of Key features**:-

1) Have used latest version- Selenium 4 
2) Support for Remote Webdriver execution on Selenium Grid using docker
3) Have used Page Object Model (POM) design pattern
4) Parallel run, threads- 5
5) Support to run in headless mode
6) Allure reports support for Reporting 

# Steps to run

### To create selenium grid using docker compose
Install Docker

`cd dockerFiles/`

`docker compose -p selenium-infra up --scale chrome=2 --scale firefox=2 -d
`


### Local webdriver execution:
`mvn clean test -DmoduleName=Registration -Dbrowser=chrome -Dhost=local`


### Remote webdriver execution on Selenium Grid:
`mvn clean test -DmoduleName=Registration -Dbrowser=chrome -Dhost=grid -DhubUrl=localhost -DbrowserVersion=150.0`


**browser** values:
- chrome
- firefox

**browserVersion** values:
- For chrome / chromium
  - 150.0

- For firefox
  - 152.0

**host** values:
- local
- grid

**moduleName** values (TestNG XML file):
- Registration

