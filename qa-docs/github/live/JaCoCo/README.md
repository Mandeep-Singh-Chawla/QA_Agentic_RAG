# GitHub — Mandeep-Singh-Chawla/JaCoCo

Source: https://github.com/Mandeep-Singh-Chawla/JaCoCo/blob/main/README.md

Soure code shared is sample project to practice JaCoCo . Run start.sh to create report

To implement JaCoCo in your project, please follow below steps to find Automation code coverage

a) **Prerequisite**:

1) Login to Application server with sudo user
2) Create a directory for Jacoco
3) Download jacocoagent.jar and jacococli.jar from https://www.jacoco.org/jacoco/




b) **Start the Server with JaCoCo Agent:**

1) Use this command to start your application with the JaCoCo agent:
***Java -javaagent:lib/jacocoagent.jar=address=*,port=36320,destfile=jacoco-it.exec,output=tcpserver /path/to/your-web-app.war(.jar)**
2) Replace lib/jacocoagent.jar with the actual path of JaCoCo agent JAR.
3) Replace /path/to/your-web-app.war(.jar) with the path of your Application file.
4) This command starts your web application with the JaCoCo agent and specifies the destination file (destfile=jacoco-it.exec) where JaCoCo will store the coverage data.




c) **Perform Actions on the Web Application:**

Once the server is running, run Automation scripts on the same test env where above setup is done.




d) **Dump Coverage Data:**

1) Use this JaCoCo command to dump the coverage data:
**java -jar /path/to/jacococli.jar dump --address localhost --port 36320 --destfile jacoco-it.exec**
2) Replace /path/to/jacococli.jar with the actual path of JaCoCo CLI JAR.
3) Adjust --address and --port if you have configured the JaCoCo agent with a different address and port.




e) **Generate Reports:**

1) Use this JaCoCo command to generate HTML reports:
**java -jar /path/to/jacococli.jar report jacoco-it.exec --classfiles /path/to/your/classes --sourcefiles /path/to/your/source --html report**
2) Replace /path/to/jacococli.jar with the actual path of JaCoCo CLI JAR.
3) Replace /path/to/your/classes with the path of your compiled Application classes(target/classes/com).
4) Replace /path/to/your/source with the path of your source Application source code(src/main/java).




f) **Open html report**

1) Copy report folder to local
2) Open index.html inside report folder



