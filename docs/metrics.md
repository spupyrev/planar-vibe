\subsection{Metrics}

Let \(G=(V,E)\) be a graph, and let each vertex \(v\in V\) be drawn at
\(p(v)=(x_v,y_v)\in\mathbb{R}^2\). For an edge \(e=\{u,v\}\in E\), let
\(\ell_e=\|p(u)-p(v)\|_2\). For a plane drawing with a fixed embedding, let
\(\mathcal{F}_b\) be the set of bounded faces. If \(f=(v_1,\dots,v_k)\) is the
boundary walk of a face, its area is
\[
A_f=\frac12\left|\sum_{i=1}^{k} x_{v_i}y_{v_{i+1}}-x_{v_{i+1}}y_{v_i}\right|,
\qquad v_{k+1}=v_1.
\]
All scores below lie in \([0,1]\), and larger values are better.

\begin{table}[t]
\small
\centering
\caption{Summary of the quality metrics used in this paper.}
\label{tab:metrics-summary}
\begin{tabular}{p{0.30\linewidth}p{0.15\linewidth}p{0.45\linewidth}}
\toprule
Metric & References & Purpose \\
\midrule
Angular Resolution & \cite{Mooney2025Universal,ahmed2021sgd2,dwyer2009comparison,simonetto2011impred,bekos2018crossing} & Rewards large incident angles around each vertex \\
Aspect Ratio & \cite{Mooney2025Universal,ahmed2021sgd2,dibattista1997experimental} & Penalizes drawings that are overly stretched in one direction \\
Convexity & \cite{tutte1960,tutte1963,chiba1985nicely,bonichon2004convex} &
Counts how many bounded faces are convex \\
Edge-Length Deviation & \cite{Mooney2025Universal,gray2024knitting,ahmed2021sgd2} & Rewards edge lengths that stay close to a common target \\
Edge-Length Ratio & \cite{chiu2023weights} & Robust summary of the gap between the shortest and longest edge \\
Edge Orthogonality & \cite{Mooney2025Universal,purchase2011created} & Rewards edges close to horizontal or vertical directions \\
Face-Area Uniformity & \cite{kleist2018faceareas,kleist2018thesis,biedl2013planar3trees} & Tests whether bounded faces have balanced areas \\
Node Uniformity & \cite{Mooney2025Universal} & Measures how evenly vertices occupy the drawing area \\
\midrule
Axis Alignment (opt.) & \cite{purchase2011created} & Measures reuse of horizontal and vertical coordinate lines \\
Spacing Uniformity (opt.) & \cite{Mooney2025Universal,chiu2023weights} & Detects local crowding via nearest-neighbor distances \\
\bottomrule
\end{tabular}
\end{table}

\subsubsection{Core}

\paragraph{Angular Resolution.}
Motivation: incident edges at a vertex should be well
separated~\cite{Mooney2025Universal,ahmed2021sgd2,
dwyer2009comparison,simonetto2011impred,bekos2018crossing}. For each vertex
\(v\) with degree \(d_v\ge 2\), let
\[
0\le \phi_{v,1}\le \dots \le \phi_{v,d_v}<2\pi
\]
be the directions of the edges incident to \(v\), sorted cyclically. Define the
cyclic angle gaps
\[
\alpha_{v,j}=
\begin{cases}
    \phi_{v,j+1}-\phi_{v,j}, & 1\le j<d_v,\\
    2\pi+\phi_{v,1}-\phi_{v,d_v}, & j=d_v,
\end{cases}
\]
and let \(\alpha_v^{\min}=\min_{1\le j\le d_v}\alpha_{v,j}\) and
\(\alpha_v^{\star}=2\pi/d_v\). We define \df{Angular Resolution} by
\[
1-\frac{1}{|\{v\in V:d_v\ge 2\}|}
\sum_{v:\,d_v\ge 2}
\frac{\alpha_v^{\star}-\alpha_v^{\min}}{\alpha_v^{\star}}.
\]

\paragraph{Aspect Ratio.}
Motivation: drawings should avoid being excessively stretched in one
direction~\cite{Mooney2025Universal,ahmed2021sgd2,
dibattista1997experimental}. Let \(x_{\min}=\min_{v\in V} x_v\),
\(x_{\max}=\max_{v\in V} x_v\), \(y_{\min}=\min_{v\in V} y_v\),
\(y_{\max}=\max_{v\in V} y_v\), and
\((W,H)=(x_{\max}-x_{\min},\,y_{\max}-y_{\min})\). We define
\df{Aspect Ratio} by
\[
\begin{cases}
    1, & \min\{W,H\}=0,\\[1mm]
    \frac{\min\{W,H\}}{\max\{W,H\}}, & \text{otherwise}.
\end{cases}
\]

\paragraph{Convexity.}
Motivation: in many planar drawing styles, convex faces are easier to read and
visually cleaner than non-convex ones~\cite{tutte1960,tutte1963,
chiba1985nicely,bonichon2004convex}. For a bounded face \(f=(v_1,\dots,v_k)\),
consider the signed turns along its boundary. The face is convex if all signed
turns have the same sign and no three consecutive vertices on the boundary are
collinear. Let \(\mathbf{1}_{\mathrm{conv}}(f)=1\) if \(f\) is convex, and
\(\mathbf{1}_{\mathrm{conv}}(f)=0\) otherwise. We define \df{Convexity} by
\[
\frac{1}{|\mathcal{F}_b|}
\sum_{f\in\mathcal{F}_b}\mathbf{1}_{\mathrm{conv}}(f).
\]

\paragraph{Edge-Length Deviation.}
Motivation: many drawing styles prefer edges of comparable
length~\cite{Mooney2025Universal,gray2024knitting,ahmed2021sgd2}. Let
\(E^+=\{e\in E:\ell_e>0\}\) and
\(\bar{\ell}={|E^+|}^{-1}\sum_{e\in E^+}\ell_e\). We define
\df{Edge-Length Deviation} by
\[
\frac{1}{
    1+\frac{1}{|E^+|}
    \sum_{e\in E^+}\frac{|\ell_e-\bar{\ell}|}{\bar{\ell}}
}.
\]

\paragraph{Edge-Length Ratio.}
Motivation: the ratio between the shortest and longest edge is an easily
interpretable robustness measure for edge-length
balance~\cite{chiu2023weights}. With \(E^+=\{e\in E:\ell_e>0\}\),
we define \df{Edge-Length Ratio} by
\[
\frac{\min_{e\in E^+}\ell_e}{\max_{e\in E^+}\ell_e}.
\]

\paragraph{Edge Orthogonality.}
Motivation: some drawing styles favor edges that are close to horizontal or
vertical~\cite{Mooney2025Universal,purchase2011created}. For each positive-length
edge \(e=\{u,v\}\in E^+\), let
\(\theta_e=\operatorname{atan2}(y_v-y_u,\;x_v-x_u)\) and
\(d_e=\min_{k\in\mathbb{Z}}|\theta_e-k\pi/2|\in[0,\pi/4]\). We define
\df{Edge Orthogonality} by
\[
1-\frac{1}{|E^+|}\sum_{e\in E^+}\frac{d_e}{\pi/4}.
\]

\paragraph{Face-Area Uniformity.}
Motivation: a planar drawing is visually more balanced when bounded faces have
similar area. The implementation allows larger faces to receive proportionally
more area: a face of length \(|f|\) gets target weight \(|f|-2\), matching the
number of triangles in a triangulation of that face~\cite{kleist2018faceareas,
kleist2018thesis,biedl2013planar3trees}. Let \(w_f=\max\{1,|f|-2\}\) for each
\(f\in\mathcal{F}_b\). Using only bounded faces with positive area, we define
\(x_f=A_f/\sum_{g\in\mathcal{F}_b}A_g\) and
\(p_f=w_f/\sum_{g\in\mathcal{F}_b}w_g\), and define \df{Face-Area Uniformity} by
\[
\begin{cases}
    1, & |\mathcal{F}_b|=1,\\[1mm]
    \left[1-\sqrt{
        \frac{\sum_{f\in\mathcal{F}_b}(x_f-p_f)^2}
        {1-2\min_{f\in\mathcal{F}_b} p_f+\sum_{f\in\mathcal{F}_b} p_f^2}
    }\right]_{[0,1]}, & |\mathcal{F}_b|\ge 2,
\end{cases}
\]
where \([t]_{[0,1]}=\min\{1,\max\{0,t\}\}\).

\paragraph{Node Uniformity.}
Motivation: vertices should be distributed evenly across the available drawing
area~\cite{Mooney2025Universal}. Let \(n=|V|\), and let \(W,H\) be the width
and height of the axis-aligned bounding box as above. Choose grid dimensions
\(r=\max\{1,\lfloor \sqrt{n}\rfloor\}\), \(c=\max\{1,\lceil n/r\rceil\}\), and
\(T=rc\). Partition the bounding box into a uniform \(r\times c\) grid of \(T\)
cells. For cell \(i\), let \(n_i\) be the number of vertices in that cell, let
\(\mu=n/T\) be the ideal number of vertices per cell, and define
\(D=\sum_{i=1}^{T}|n_i-\mu|\). Using the worst-case deviation when all
vertices lie in a single cell, \(D_{\max}=2n(T-1)/T\), we define
\df{Node Uniformity} by
\[
1-\frac{D}{D_{\max}}.
\]

\subsubsection{Optional}

\paragraph{Axis Alignment.}
Motivation: this score measures internal reuse of vertical and horizontal lines,
without requiring equal spacing or an external
grid~\cite{purchase2011created}. For one axis, let the coordinates be
\(v_1,\dots,v_n\) (either all \(x_v\) or all \(y_v\)), and let
\(v_{(1)}\le \dots \le v_{(n)}\) be the sorted values. If a fixed tolerance
\(\varepsilon\) is supplied, use it. Otherwise estimate it from the data. Let
\(r=v_{(n)}-v_{(1)}\), and form the positive consecutive gaps
\(g_j=v_{(j+1)}-v_{(j)}\) for those \(g_j>\max\{10^{-12},\,10^{-12}r\}\). If at
least three such gaps exist, let \(q_{0.2}\) be the empirical \(20\%\)-quantile
of \(\{g_j\}\) using linear interpolation, and set
\[
\varepsilon
=
\min\!\left\{
0.05\,r,\;
\max\!\left(\max\{10^{-12},\,10^{-9}r\},\;2q_{0.2}\right)
\right\}.
\]
Otherwise set \(\varepsilon=0.01\,r\). If \(r=0\), set \(\varepsilon=0\).
Next, cluster the sorted values by scanning from left to right and starting a
new cluster whenever the next gap exceeds \(\varepsilon\). Let the cluster sizes
be \(a_1,\dots,a_L\), so \(\sum_{i=1}^{L} a_i=n\). Define
\(p_i=a_i/n\), \(L_{\mathrm{eff}}=1/\sum_{i=1}^{L} p_i^2\), and
\(S_{\mathrm{axis}}(v_1,\dots,v_n)=({n-L_{\mathrm{eff}}})/({n-1})\). The final
alignment score averages the two axes. We define \df{Axis Alignment} by
\[
\frac12\left(
S_{\mathrm{axis}}((x_v)_{v\in V})
+
S_{\mathrm{axis}}((y_v)_{v\in V})
\right).
\]

\paragraph{Spacing Uniformity.}
Motivation: a drawing should avoid local crowding and very uneven vertex
separation~\cite{Mooney2025Universal,chiu2023weights}. Let
\(P=\{p(v):v\in V\}\), \(n=|P|\), \(x_{\min}=\min_{v\in V} x_v\),
\(x_{\max}=\max_{v\in V} x_v\), \(y_{\min}=\min_{v\in V} y_v\), and
\(y_{\max}=\max_{v\in V} y_v\). If \(n\ge 10\), compute for each vertex its
distance to the boundary of the axis-aligned bounding box,
\(b_v=\min\{x_v-x_{\min},\,x_{\max}-x_v,\,y_v-y_{\min},\,y_{\max}-y_v\}\), and
discard the \(\lfloor 0.1n\rfloor\) vertices with smallest \(b_v\). If \(n<10\),
keep all vertices. Let \(U\subseteq V\) be the retained set. For each \(v\in U\),
let \(\delta_v=\min_{u\in U,\;u\neq v}\|p(u)-p(v)\|_2\), and keep only positive
\(\delta_v\). If the remaining number of distances is \(m\), define
\(\bar{\delta}=m^{-1}\sum_v\delta_v\),
\(\sigma_\delta=\sqrt{m^{-1}\sum_v(\delta_v-\bar{\delta})^2}\), and
\(\mathrm{CV}_\delta=\sigma_\delta/\bar{\delta}\). We define
\df{Spacing Uniformity} by
\[
\frac{1}{1+\mathrm{CV}_\delta}.
\]
